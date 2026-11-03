"""Dependency-free, SQLite-backed G1 *contract prototype*.

No Provider network call, OS spawn, grant signature, sandbox or trusted receipt verifier
is implemented. Synthetic issuer/receipt flags are test doubles, NOT security proof.
K and G must use separate DB paths; each owns its local transaction boundary.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Optional


class Rejected(RuntimeError):
    """A guard rejected a command; no authoritative transition was committed."""


class Conflict(Rejected):
    """An idempotency key was reused for different bytes or a CAS binding is stale."""


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ChargeBound:
    issuer: str
    request_digest: str
    maximum_minor: int
    expires_at: float
    all_billable_dimensions_proven: bool


class _Store:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5)
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.lock = threading.RLock()

    @contextmanager
    def transaction(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise

    def close(self):
        self.conn.close()


class Kernel(_Store):
    TERMINAL = {"COMPLETED", "FAILED", "CANCELLED"}

    def __init__(self, path: str, *, trusted_bound_issuers: frozenset[str] = frozenset(), allow_r1: bool = False):
        super().__init__(path)
        self.trusted_bound_issuers = trusted_bound_issuers
        self.allow_r1 = allow_r1
        with self.lock:
            self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS task (
              id TEXT PRIMARY KEY, state TEXT NOT NULL, control_version INTEGER NOT NULL,
              plan_epoch INTEGER NOT NULL, authority_epoch INTEGER NOT NULL,
              workspace_digest TEXT NOT NULL, workspace_epoch INTEGER NOT NULL,
              criteria TEXT NOT NULL, revocation_pending INTEGER NOT NULL DEFAULT 0,
              cancel_accepted INTEGER NOT NULL DEFAULT 0, terminal_reason TEXT);
            CREATE TABLE IF NOT EXISTS budget (
              task_id TEXT PRIMARY KEY REFERENCES task(id), ceiling INTEGER NOT NULL,
              spent INTEGER NOT NULL DEFAULT 0, enforcement_hold INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS step (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id),
              selected_attempt TEXT, status TEXT NOT NULL DEFAULT 'OPEN');
            CREATE TABLE IF NOT EXISTS attempt (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id),
              step_id TEXT NOT NULL REFERENCES step(id), request_digest TEXT NOT NULL,
              plan_epoch INTEGER NOT NULL, authority_epoch INTEGER NOT NULL, workspace_epoch INTEGER NOT NULL,
              maximum INTEGER NOT NULL, state TEXT NOT NULL, candidate_digest TEXT,
              candidate_seq INTEGER, billed INTEGER);
            CREATE TABLE IF NOT EXISTS invocation (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id),
              plan_epoch INTEGER NOT NULL, authority_epoch INTEGER NOT NULL,
              workspace_epoch INTEGER NOT NULL, args_digest TEXT NOT NULL,
              risk TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
              converged INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS evidence (
              task_id TEXT NOT NULL REFERENCES task(id), criterion_id TEXT NOT NULL,
              plan_epoch INTEGER NOT NULL, workspace_epoch INTEGER NOT NULL, workspace_digest TEXT NOT NULL,
              effective_digest TEXT NOT NULL, receipt_id TEXT NOT NULL,
              verdict TEXT NOT NULL, sealed INTEGER NOT NULL, isolated INTEGER NOT NULL,
              PRIMARY KEY(task_id, criterion_id));
            CREATE TABLE IF NOT EXISTS journal (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (
              id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS command (
              id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS unresolved_hold (
              id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id),
              reason TEXT NOT NULL, conflict_scope TEXT NOT NULL,
              resolution_state TEXT NOT NULL DEFAULT 'OPEN');
            """)

    def _command(self, command_id: str, request: dict, act: Callable):
        if not command_id:
            raise Rejected("command id required")
        fingerprint = digest(request)
        with self.transaction() as c:
            old = c.execute("SELECT request_digest,result FROM command WHERE id=?", (command_id,)).fetchone()
            if old:
                if old[0] != fingerprint:
                    raise Conflict("idempotency key payload mismatch")
                return json.loads(old[1])
            result = act(c)
            c.execute("INSERT INTO command VALUES (?,?,?)", (command_id, fingerprint, canonical(result)))
            return result

    @staticmethod
    def _active(c, task_id: str):
        row = c.execute("SELECT state,plan_epoch,authority_epoch,workspace_epoch,workspace_digest,revocation_pending,control_version,criteria,cancel_accepted FROM task WHERE id=?", (task_id,)).fetchone()
        if not row or row[0] != "RUNNING" or row[5] or row[8]:
            raise Rejected("task not active or authority revocation pending")
        return row

    def new_task(self, task_id: str, *, workspace_digest: str, criteria: tuple[str, ...], ceiling_minor: int):
        if not task_id or not workspace_digest or ceiling_minor < 0 or not criteria or len(criteria) != len(set(criteria)):
            raise Rejected("invalid task contract")
        with self.transaction() as c:
            c.execute("INSERT INTO task (id,state,control_version,plan_epoch,authority_epoch,workspace_digest,workspace_epoch,criteria,revocation_pending) VALUES (?,?,?,?,?,?,?,?,?)", (task_id, "RUNNING", 0, 1, 1, workspace_digest, 1, canonical(criteria), 0))
            c.execute("INSERT INTO budget(task_id,ceiling) VALUES (?,?)", (task_id, ceiling_minor))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('TaskCreated',?)", (task_id,))

    def progress_fingerprint(self, task_id: str) -> str:
        """A conservative synthetic *goal-progress* signal, not an authority.

        Budget settlement, model attempts and receipt chatter never count.
        This is NOT a production-grade novelty/repair-progress proof.
        """
        with self.lock:
            c = self.conn
            task = c.execute(
                "SELECT workspace_digest FROM task WHERE id=?", (task_id,)
            ).fetchall()
            evidence = c.execute(
                "SELECT criterion_id,plan_epoch,workspace_digest,receipt_id,verdict "
                "FROM evidence WHERE task_id=? ORDER BY criterion_id", (task_id,)
            ).fetchall()
        return digest([task, evidence])

    def task(self, task_id: str) -> dict:
        with self.lock:
            r = self.conn.execute("SELECT state,control_version,plan_epoch,authority_epoch,workspace_epoch,workspace_digest,revocation_pending,cancel_accepted,terminal_reason FROM task WHERE id=?", (task_id,)).fetchone()
        if not r:
            raise Rejected("unknown task")
        return dict(zip(("state", "control_version", "plan_epoch", "authority_epoch", "workspace_epoch", "workspace_digest", "revocation_pending", "cancel_accepted", "terminal_reason"), r))

    def budget(self, task_id: str) -> dict:
        with self.lock:
            r = self.conn.execute("SELECT ceiling,spent,enforcement_hold FROM budget WHERE task_id=?", (task_id,)).fetchone()
            reserved = self.conn.execute("SELECT COALESCE(SUM(maximum),0) FROM attempt WHERE task_id=? AND billed IS NULL", (task_id,)).fetchone()[0]
        if r is None:
            raise Rejected("unknown budget")
        return {"ceiling": r[0], "spent": r[1], "reserved": reserved, "enforcement_hold": bool(r[2])}

    def admit_attempt(self, command_id: str, *, task_id: str, step_id: str, attempt_id: str,
                      request_digest: str, bound: ChargeBound):
        request = dict(op="admit_attempt", task=task_id, step=step_id, attempt=attempt_id,
                       request_digest=request_digest, bound=vars(bound))
        def act(c):
            t=self._active(c, task_id)
            if (bound.issuer not in self.trusted_bound_issuers or not bound.all_billable_dimensions_proven
                or bound.request_digest != request_digest or not request_digest
                or bound.maximum_minor < 0 or bound.expires_at <= time.time()):
                raise Rejected("unqualified maximum-charge certificate")
            s = c.execute("SELECT task_id,selected_attempt FROM step WHERE id=?", (step_id,)).fetchone()
            if s and (s[0] != task_id or s[1] is not None):
                raise Rejected("step is not open for this task")
            if not s:
                c.execute("INSERT INTO step(id,task_id) VALUES (?,?)", (step_id, task_id))
            ceiling, spent, hold = c.execute("SELECT ceiling,spent,enforcement_hold FROM budget WHERE task_id=?", (task_id,)).fetchone()
            reserved = c.execute("SELECT COALESCE(SUM(maximum),0) FROM attempt WHERE task_id=? AND billed IS NULL", (task_id,)).fetchone()[0]
            if hold or ceiling - spent - reserved < bound.maximum_minor:
                raise Rejected("hard budget exhausted or held")
            c.execute("INSERT INTO attempt(id,task_id,step_id,request_digest,plan_epoch,authority_epoch,workspace_epoch,maximum,state) VALUES (?,?,?,?,?,?,?,?,?)",
                      (attempt_id,task_id,step_id,request_digest,t[1],t[2],t[3],bound.maximum_minor,"ADMITTED"))
            c.execute("INSERT INTO outbox VALUES (?,?,?)", ("model:"+attempt_id, "K_TO_G", canonical({"attempt":attempt_id,"digest":request_digest})))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('ModelAttemptAdmitted',?)", (attempt_id,))
            return {"attempt_id": attempt_id, "outbox_id": "model:"+attempt_id}
        return self._command(command_id, request, act)

    def provider_unknown(self, command_id: str, attempt_id: str):
        def act(c):
            row = c.execute("SELECT state FROM attempt WHERE id=?", (attempt_id,)).fetchone()
            if not row or row[0] not in ("ADMITTED", "UNKNOWN"):
                raise Rejected("invalid unknown transition")
            c.execute("UPDATE attempt SET state='UNKNOWN' WHERE id=?", (attempt_id,))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('ProviderOutcomeUnknown',?)", (attempt_id,))
            return {"state": "UNKNOWN"}
        return self._command(command_id, dict(op="unknown",attempt=attempt_id), act)

    def record_candidate(self, command_id: str, *, attempt_id: str, response_digest: str, complete: bool):
        def act(c):
            a = c.execute("SELECT task_id,step_id,state,plan_epoch,authority_epoch,workspace_epoch FROM attempt WHERE id=?", (attempt_id,)).fetchone()
            if not a or a[2] not in ("ADMITTED", "UNKNOWN") or not complete or not response_digest:
                raise Rejected("incomplete, unknown or duplicate response")
            t=self._active(c, a[0])
            if (a[3],a[4],a[5]) != (t[1],t[2],t[3]):
                raise Rejected("model candidate bound to stale protected input")
            c.execute("INSERT INTO journal(kind,ref) VALUES ('CandidateRecorded',?)", (attempt_id,))
            seq = c.execute("SELECT last_insert_rowid()").fetchone()[0]
            c.execute("UPDATE attempt SET state='COMPLETE',candidate_digest=?,candidate_seq=? WHERE id=?",
                      (response_digest, seq, attempt_id))
            return {"candidate_seq": seq}
        return self._command(command_id, dict(op="candidate",attempt=attempt_id,response=response_digest,complete=complete), act)

    def select_candidate(self, command_id: str, *, task_id: str, step_id: str):
        def act(c):
            t=self._active(c, task_id)
            s = c.execute("SELECT task_id,selected_attempt FROM step WHERE id=?", (step_id,)).fetchone()
            if not s or s[0] != task_id:
                raise Rejected("step not found")
            if s[1]:
                return {"selected": s[1]}
            a = c.execute("SELECT id,candidate_digest FROM attempt WHERE task_id=? AND step_id=? AND state='COMPLETE' AND plan_epoch=? AND authority_epoch=? AND workspace_epoch=? ORDER BY candidate_seq,id LIMIT 1", (task_id,step_id,t[1],t[2],t[3])).fetchone()
            if not a:
                raise Rejected("no complete candidate")
            c.execute("UPDATE step SET selected_attempt=?,status='COMPLETED' WHERE id=?", (a[0],step_id))
            c.execute("INSERT INTO outbox VALUES (?,?,?)", ("delivery:"+step_id,"K_TO_ORCHESTRATOR",canonical({"selected":a[0],"response_digest":a[1]})))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('ModelStepSelected',?)", (a[0],))
            return {"selected": a[0]}
        return self._command(command_id, dict(op="select",task=task_id,step=step_id), act)

    def settle_charge(self, command_id: str, *, attempt_id: str, billed_minor: int, authenticated: bool):
        def act(c):
            a = c.execute("SELECT task_id,maximum,billed FROM attempt WHERE id=?", (attempt_id,)).fetchone()
            if not authenticated or not a or a[2] is not None or billed_minor < 0:
                raise Rejected("no trusted new financial settlement")
            overrun = billed_minor > a[1]
            c.execute("UPDATE attempt SET billed=? WHERE id=?", (billed_minor,attempt_id))
            c.execute("UPDATE budget SET spent=spent+?,enforcement_hold=CASE WHEN ? THEN 1 ELSE enforcement_hold END WHERE task_id=?",
                      (billed_minor,int(overrun),a[0]))
            c.execute("INSERT INTO journal(kind,ref) VALUES (?,?)", ("BudgetOverrun" if overrun else "ChargeSettled",attempt_id))
            return {"billed": billed_minor, "overrun": overrun}
        return self._command(command_id, dict(op="settle",attempt=attempt_id,billed=billed_minor,authenticated=authenticated), act)

    def admit_tool(self, command_id: str, *, task_id: str, invocation_id: str,
                   args_digest: str, nonce: str, plan_epoch: int, authority_epoch: int,
                   workspace_epoch: int, risk: str):
        def act(c):
            t = self._active(c, task_id)
            if (not args_digest or not nonce or risk not in ("R0", "R1")
                or (risk == "R1" and not self.allow_r1)
                or (plan_epoch,authority_epoch,workspace_epoch) != (t[1],t[2],t[3])):
                raise Rejected("protected read-set stale or effect risk not approved")
            c.execute("INSERT INTO invocation VALUES (?,?,?,?,?,?,?,?,?,0)",
                      (invocation_id,task_id,plan_epoch,authority_epoch,workspace_epoch,args_digest,risk,nonce,"DISPATCH_PENDING"))
            c.execute("INSERT INTO outbox VALUES (?,?,?)", ("tool:"+invocation_id,"K_TO_HOST",canonical({"invocation":invocation_id,"nonce":nonce,"args_digest":args_digest})))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('ToolInvocationAdmitted',?)", (invocation_id,))
            return {"invocation_id": invocation_id, "outbox_id": "tool:"+invocation_id}
        return self._command(command_id, dict(op="admit_tool",task=task_id,invocation=invocation_id,args=args_digest,nonce=nonce,plan=plan_epoch,authority=authority_epoch,workspace=workspace_epoch,risk=risk), act)

    def host_result(self, command_id: str, *, invocation_id: str, status: str,
                    converged: bool, authenticated: bool):
        def act(c):
            old = c.execute("SELECT state,converged FROM invocation WHERE id=?", (invocation_id,)).fetchone()
            if not authenticated or not old or status not in ("UNKNOWN","SUCCEEDED","FAILED"):
                raise Rejected("untrusted or conflicting Host receipt")
            if old[0] in ("SUCCEEDED", "FAILED"):
                if old[0] != status or old[1] or not converged:
                    raise Rejected("known outcome cannot be changed; only process convergence may advance")
            elif old[0] not in ("DISPATCH_PENDING", "UNKNOWN"):
                raise Rejected("invalid Host state transition")
            if status == "UNKNOWN" and converged:
                raise Rejected("unknown cannot assert convergence")
            c.execute("UPDATE invocation SET state=?,converged=? WHERE id=?", (status,int(converged),invocation_id))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('HostReceiptImported',?)", (invocation_id,))
            return {"state": status, "converged": converged}
        return self._command(command_id, dict(op="host_result",invocation=invocation_id,status=status,converged=converged,authenticated=authenticated), act)

    def update_workspace(self, command_id: str, *, task_id: str, old_epoch: int, new_digest: str):
        def act(c):
            t=self._active(c,task_id)
            if t[3] != old_epoch or not new_digest:
                raise Conflict("stale workspace mutation")
            if not self._no_unresolved_effect(c,task_id):
                raise Rejected("workspace cutover requires effect reconciliation/fence")
            c.execute("UPDATE task SET workspace_epoch=workspace_epoch+1,workspace_digest=? WHERE id=?", (new_digest,task_id))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('WorkspaceChanged',?)", (task_id,))
            return {"workspace_epoch":old_epoch+1}
        return self._command(command_id,dict(op="workspace",task=task_id,old=old_epoch,new=new_digest),act)

    def structural_replan(self, command_id: str, *, task_id: str, expected_control_version: int):
        """Only L2 alters immutable plan identity; in-flight unresolved effects block cutover."""
        def act(c):
            t=self._active(c,task_id)
            if t[6] != expected_control_version:
                raise Conflict("stale TaskControl CAS")
            if not self._no_unresolved_effect(c,task_id):
                raise Rejected("drain/reconcile before structural cutover")
            c.execute("UPDATE task SET plan_epoch=plan_epoch+1,control_version=control_version+1 WHERE id=?", (task_id,))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('PlanCutover',?)", (task_id,))
            return {"plan_epoch":t[1]+1,"control_version":expected_control_version+1}
        return self._command(command_id,dict(op="L2_replan",task=task_id,version=expected_control_version),act)

    def record_coding_evidence(self, command_id: str, *, task_id: str, criterion_id: str,
                               plan_epoch: int, workspace_epoch: int, source_digest: str, effective_digest: str,
                               receipt_id: str, trusted: bool, sealed_readonly: bool,
                               outputs_disjoint: bool, verdict: str):
        def act(c):
            t = self._active(c,task_id)
            if (criterion_id not in json.loads(t[7]) or plan_epoch != t[1] or workspace_epoch != t[3]
                or source_digest != t[4] or effective_digest != source_digest
                or not receipt_id or not trusted or not sealed_readonly or not outputs_disjoint or verdict != "PASS"):
                raise Rejected("unbound or untrusted effective verification view")
            c.execute("INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,criterion_id) DO UPDATE SET plan_epoch=excluded.plan_epoch,workspace_epoch=excluded.workspace_epoch,workspace_digest=excluded.workspace_digest,effective_digest=excluded.effective_digest,receipt_id=excluded.receipt_id,verdict=excluded.verdict,sealed=excluded.sealed,isolated=excluded.isolated",
                      (task_id,criterion_id,plan_epoch,workspace_epoch,source_digest,effective_digest,receipt_id,verdict,1,1))
            c.execute("INSERT INTO journal(kind,ref) VALUES ('VerificationEvidenceBound',?)", (criterion_id,))
            return {"criterion": criterion_id}
        return self._command(command_id, dict(op="evidence",task=task_id,criterion=criterion_id,plan=plan_epoch,epoch=workspace_epoch,source=source_digest,effective=effective_digest,receipt=receipt_id,trusted=trusted,sealed=sealed_readonly,isolated=outputs_disjoint,verdict=verdict),act)

    @staticmethod
    def _no_unresolved_effect(c, task_id):
        pending = c.execute("SELECT COUNT(*) FROM invocation WHERE task_id=? AND (state IN ('DISPATCH_PENDING','UNKNOWN') OR converged=0)", (task_id,)).fetchone()[0]
        return pending == 0

    def request_cancel(self, command_id: str, *, task_id: str, expected_control_version: int):
        """Accept cancellation as its own durable, admission-blocking control fact."""
        def act(c):
            t = c.execute(
                "SELECT state,control_version,cancel_accepted FROM task WHERE id=?",
                (task_id,)
            ).fetchone()
            if not t or t[0] != "RUNNING" or t[1] != expected_control_version:
                raise Conflict("cancellation CAS stale or task not Open")
            if t[2]:
                return {"cancel_accepted": True, "control_version": t[1]}
            c.execute(
                "UPDATE task SET cancel_accepted=1,control_version=control_version+1 "
                "WHERE id=?", (task_id,)
            )
            c.execute("INSERT INTO journal(kind,ref) VALUES ('CancelAccepted',?)", (task_id,))
            return {"cancel_accepted": True, "control_version": t[1]+1}
        return self._command(
            command_id, dict(op="request_cancel",task=task_id,version=expected_control_version), act
        )

    def commit_terminal(self, command_id: str, *, task_id: str, expected_control_version: int,
                        status: str, reason: Optional[str] = None):
        """One authority path for Completed/Failed/Cancelled (synthetic only).

        A Failed(UnresolvedEffect) retains a durable, *unfenced* recovery hold.
        This reference MUST NOT be interpreted as actual Host isolation.
        """
        if status not in self.TERMINAL:
            raise Rejected("unsupported terminal status")
        valid_failure_reasons = {
            "DeadlineExceeded", "NoProgress", "BudgetExhausted", "UnsafeEnvironment",
            "RepairExhausted", "UnresolvedEffect", "DependencyFailed", "PolicyDenied",
        }
        valid_cancel_reasons = {
            "UserRequested", "Superseded", "AuthorityRevoked", "DependencyCancelled",
        }
        if (status == "FAILED" and reason not in valid_failure_reasons or
            status == "CANCELLED" and reason not in valid_cancel_reasons or
            status == "COMPLETED" and reason is not None):
            raise Rejected("invalid status-specific terminal reason")

        def act(c):
            t = c.execute(
                "SELECT state,control_version,cancel_accepted,plan_epoch,workspace_epoch,"
                "workspace_digest,criteria FROM task WHERE id=?", (task_id,)
            ).fetchone()
            if not t or t[0] != "RUNNING" or t[1] != expected_control_version:
                raise Conflict("terminal CAS stale or task already terminal")
            unresolved = not self._no_unresolved_effect(c, task_id)
            if status == "COMPLETED":
                if t[2] or unresolved:
                    raise Rejected("cancellation pending or physical effects unresolved")
                if c.execute(
                    "SELECT enforcement_hold FROM budget WHERE task_id=?",
                    (task_id,)
                ).fetchone()[0]:
                    raise Rejected("budget integrity hold")
                for criterion in json.loads(t[6]):
                    row = c.execute(
                        "SELECT plan_epoch,workspace_epoch,workspace_digest,"
                        "effective_digest,verdict,sealed,isolated FROM evidence "
                        "WHERE task_id=? AND criterion_id=?", (task_id, criterion)
                    ).fetchone()
                    if not row or row != (t[3],t[4],t[5],t[5],"PASS",1,1):
                        raise Rejected("required criterion unverified or stale")
                c.execute(
                    "INSERT INTO journal(kind,ref) VALUES ('CompletionCommitted',?)",
                    (task_id,)
                )
            elif status == "CANCELLED":
                if not t[2] or unresolved:
                    raise Rejected("cancellation not accepted or effects not converged")
            elif unresolved and reason != "UnresolvedEffect":
                raise Rejected("unresolved effect requires typed failure and hold")

            if status == "FAILED" and reason == "UnresolvedEffect":
                if not unresolved:
                    raise Rejected("no unresolved effect to hold")
                c.execute(
                    "INSERT INTO unresolved_hold(id,task_id,reason,conflict_scope) "
                    "VALUES (?,?,?,?)",
                    ("terminal-hold:"+task_id,task_id,reason,"task:"+task_id)
                )
                c.execute(
                    "INSERT INTO journal(kind,ref) VALUES ('UnresolvedEffectHoldOpened',?)",
                    (task_id,)
                )
            c.execute(
                "UPDATE task SET state=?,terminal_reason=?,control_version=control_version+1 "
                "WHERE id=?", (status,reason,task_id)
            )
            c.execute("INSERT INTO journal(kind,ref) VALUES ('TaskTerminal',?)", (task_id,))
            c.execute(
                "INSERT INTO outbox VALUES (?,?,?)",
                ("terminal:"+task_id,"K_TO_USER",
                 canonical({"task":task_id,"state":status,"reason":reason}))
            )
            return {"state":status,"reason":reason}

        return self._command(
            command_id,
            dict(op="commit_terminal",task=task_id,version=expected_control_version,
                 status=status,reason=reason),
            act
        )

    def complete(self, command_id: str, *, task_id: str, expected_control_version: int):
        """Compatibility adapter: delegates to the sole CommitTerminal transaction."""
        return self.commit_terminal(
            command_id, task_id=task_id, expected_control_version=expected_control_version,
            status="COMPLETED"
        )


class GatewaySendLedger(_Store):
    """Separate durable G owner: mark-before-send; never infer safe provider replay."""
    def __init__(self, path: str):
        super().__init__(path)
        with self.transaction() as c:
            c.execute("CREATE TABLE IF NOT EXISTS send (attempt_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, may_have_sent INTEGER NOT NULL)")

    def mark_may_have_sent(self, attempt_id: str, request_digest: str) -> bool:
        """True only for the first marker. False means DO NOT send again."""
        if not attempt_id or not request_digest:
            raise Rejected("invalid provider request identity")
        with self.transaction() as c:
            old=c.execute("SELECT request_digest FROM send WHERE attempt_id=?", (attempt_id,)).fetchone()
            if old:
                if old[0] != request_digest:
                    raise Conflict("same Attempt changed request bytes")
                return False
            c.execute("INSERT INTO send VALUES (?,?,1)", (attempt_id,request_digest))
            return True


class SingleLoop:
    """Bounded decision driver. A model/decision policy may suggest, never commit completion."""
    def __init__(self, kernel: Kernel, *, max_decisions: int = 32, max_no_progress: int = 3):
        if max_decisions < 1 or max_no_progress < 1:
            raise ValueError("positive limits required")
        self.kernel=kernel
        self.max_decisions=max_decisions
        self.max_no_progress=max_no_progress

    def run(self, task_id: str, policy: Callable[[int], str], *, deadline_monotonic: Optional[float] = None):
        stalled=0
        cursor=self.kernel.progress_fingerprint(task_id)
        for i in range(self.max_decisions):
            if self.kernel.task(task_id)["state"] != "RUNNING":
                return self.kernel.task(task_id)["state"]
            if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
                self.kernel.commit_terminal("loop:deadline:"+task_id,task_id=task_id,
                    expected_control_version=self.kernel.task(task_id)["control_version"],
                    status="FAILED",reason="DeadlineExceeded")
                return "FAILED"
            action=policy(i)
            if action == "WAIT":
                return "BLOCKED"  # still no durable WaitRecord/watchdog in this disposable prototype
            if action == "COMPLETE":
                self.kernel.complete("loop:complete:"+task_id,task_id=task_id,
                    expected_control_version=self.kernel.task(task_id)["control_version"])
                return "COMPLETED"
            new_cursor=self.kernel.progress_fingerprint(task_id)
            if action not in ("PROGRESS", "NO_PROGRESS"):
                raise Rejected("invalid policy disposition")
            if action == "PROGRESS" and new_cursor != cursor:
                stalled=0
                cursor=new_cursor
            else:
                stalled+=1
                if stalled >= self.max_no_progress:
                    self.kernel.commit_terminal("loop:stalled:"+task_id,task_id=task_id,
                        expected_control_version=self.kernel.task(task_id)["control_version"],
                        status="FAILED",reason="NoProgress")
                    return "FAILED"
        self.kernel.commit_terminal("loop:limit:"+task_id,task_id=task_id,
            expected_control_version=self.kernel.task(task_id)["control_version"],
            status="FAILED",reason="NoProgress")
        return "FAILED"
