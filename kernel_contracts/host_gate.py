"""A *simulated* single-Host ledger/gate for G2 ordering fixtures.

It does not start processes or authenticate signatures. The callback marks the
physical-spawn boundary only in tests; real OS, sandbox and grant proof are OPEN.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from .protocol import _Store, Rejected


@dataclass(frozen=True)
class SyntheticTicket:
    invocation_id: str
    nonce: str
    args_digest: str
    host_incarnation: str
    authority_epoch: int
    workspace_epoch: int
    deadline_monotonic: float
    risk: str
    authenticated: bool


class SimulatedHostGate(_Store):
    def __init__(self, path: str, *, incarnation: str, allow_r1: bool = False):
        if not incarnation:
            raise ValueError("incarnation is required")
        super().__init__(path)
        self.incarnation=incarnation
        self.allow_r1=allow_r1
        with self.lock:
            self.conn.executescript("""
                CREATE TABLE IF NOT EXISTS gate (
                  id INTEGER PRIMARY KEY CHECK(id=1), incarnation TEXT NOT NULL,
                  installed_epoch INTEGER NOT NULL, workspace_epoch INTEGER NOT NULL,
                  sequence INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS launch (
                  nonce TEXT PRIMARY KEY, invocation_id TEXT NOT NULL, args_digest TEXT NOT NULL,
                  state TEXT NOT NULL, gate_sequence INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS fence (
                  epoch INTEGER PRIMARY KEY, gate_sequence INTEGER NOT NULL,
                  incarnation TEXT NOT NULL);
            """)
        with self.transaction() as c:
            c.execute("INSERT OR IGNORE INTO gate VALUES (1,?,1,1,0)", (incarnation,))
            existing=c.execute("SELECT incarnation FROM gate WHERE id=1").fetchone()[0]
        if existing != incarnation:
            self.close()
            raise Rejected("Host incarnation changed: explicit re-enrollment required")

    def snapshot(self):
        with self.lock:
            epoch,workspace,seq=self.conn.execute("SELECT installed_epoch,workspace_epoch,sequence FROM gate WHERE id=1").fetchone()
            return {"installed_epoch":epoch,"workspace_epoch":workspace,"sequence":seq}

    def install_fence(self, desired_epoch: int):
        """Locally ordered fence ACK; not a Kernel Revoked or process-converged fact."""
        with self.transaction() as c:
            current,seq=c.execute("SELECT installed_epoch,sequence FROM gate WHERE id=1").fetchone()
            if desired_epoch <= current:
                raise Rejected("fence must advance epoch")
            c.execute("UPDATE gate SET installed_epoch=?,sequence=sequence+1 WHERE id=1",(desired_epoch,))
            c.execute("INSERT INTO fence VALUES (?,?,?)",(desired_epoch,seq+1,self.incarnation))
            return {"installed_epoch":desired_epoch,"sequence":seq+1,"incarnation":self.incarnation}

    def advance_workspace(self, desired_epoch: int):
        with self.transaction() as c:
            current=c.execute("SELECT workspace_epoch FROM gate WHERE id=1").fetchone()[0]
            if desired_epoch <= current:
                raise Rejected("workspace fence must advance")
            c.execute("UPDATE gate SET workspace_epoch=?,sequence=sequence+1 WHERE id=1",(desired_epoch,))

    def launch(self, ticket: SyntheticTicket, *, authority_channel_live: bool,
               spawn_boundary: Callable[[], None], crash_after_intent: bool = False) -> str:
        """Consume nonce durably before a simulated launch; never retry UNKNOWN.

        The host-local gate lock covers validation, durable intent and callback.
        A callback exception represents an ambiguous physical boundary, not failure.
        """
        with self.lock:  # Also serializes install_fence and workspace changes.
            with self.transaction() as c:
                current,workspace,seq=c.execute("SELECT installed_epoch,workspace_epoch,sequence FROM gate WHERE id=1").fetchone()
                if (not ticket.authenticated or not authority_channel_live
                    or ticket.host_incarnation != self.incarnation
                    or ticket.authority_epoch != current
                    or ticket.workspace_epoch != workspace
                    or ticket.deadline_monotonic <= time.monotonic()
                    or not ticket.nonce or not ticket.args_digest or not ticket.invocation_id
                    or ticket.risk not in ("R0","R1") or (ticket.risk == "R1" and not self.allow_r1)):
                    raise Rejected("Host gate authority, expiry, fence or risk check failed")
                if c.execute("SELECT 1 FROM launch WHERE nonce=?",(ticket.nonce,)).fetchone():
                    raise Rejected("nonce already consumed; reconcile original physical effect")
                c.execute("UPDATE gate SET sequence=sequence+1 WHERE id=1")
                c.execute("INSERT INTO launch VALUES (?,?,?,?,?)",(ticket.nonce,ticket.invocation_id,ticket.args_digest,"INTENT_DURABLE",seq+1))
            if crash_after_intent:
                # A crash could have been between intent and an actual OS spawn.
                return "UNKNOWN"
            try:
                spawn_boundary()
            except BaseException:
                with self.transaction() as c:
                    c.execute("UPDATE launch SET state='UNKNOWN' WHERE nonce=?",(ticket.nonce,))
                return "UNKNOWN"
            with self.transaction() as c:
                c.execute("UPDATE launch SET state='LAUNCH_BOUNDARY_RECORDED' WHERE nonce=?",(ticket.nonce,))
            return "LAUNCH_BOUNDARY_RECORDED"
