"""Synthetic local gate ordering; no real OS process/sandbox is exercised."""
import os
import tempfile
import time
import unittest

from kernel_contracts import Rejected, SimulatedHostGate, SyntheticTicket


class HostGateTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=os.path.join(self.temp.name,"host.db")
        self.h=SimulatedHostGate(self.path,incarnation="host-boot-A")

    def tearDown(self):
        self.h.close()
        self.temp.cleanup()

    def ticket(self, nonce="n", **changed):
        kwargs=dict(invocation_id="invoke",nonce=nonce,args_digest="args",
                    host_incarnation="host-boot-A",authority_epoch=1,workspace_epoch=1,
                    deadline_monotonic=time.monotonic()+10,risk="R0",authenticated=True)
        kwargs.update(changed)
        return SyntheticTicket(**kwargs)

    def test_request_before_local_fence_does_not_claim_instant_revocation(self):
        launched=[]
        # A remote K RevocationRequested is intentionally not yet installed at H.
        self.assertEqual(self.h.launch(self.ticket(),authority_channel_live=True,
                                       spawn_boundary=lambda:launched.append("spawn")),"LAUNCH_BOUNDARY_RECORDED")
        self.assertEqual(launched,["spawn"])
        ack=self.h.install_fence(2)
        self.assertEqual(ack["installed_epoch"],2)
        with self.assertRaises(Rejected):
            self.h.launch(self.ticket("second-old"),authority_channel_live=True,spawn_boundary=lambda:launched.append("bad"))
        self.assertEqual(launched,["spawn"])

    def test_expiry_offline_stale_workspace_and_r2_fail_closed(self):
        fixtures=(
            (self.ticket("expired",deadline_monotonic=time.monotonic()-1),True),
            (self.ticket("offline"),False),
            (self.ticket("r2",risk="R2"),True),
            (self.ticket("r1",risk="R1"),True),
            (self.ticket("forged",authenticated=False),True),
        )
        for ticket,online in fixtures:
            with self.subTest(ticket=ticket.nonce),self.assertRaises(Rejected):
                self.h.launch(ticket,authority_channel_live=online,spawn_boundary=lambda:self.fail("unexpected spawn"))
        self.h.advance_workspace(2)
        with self.assertRaises(Rejected):
            self.h.launch(self.ticket("stale-workspace"),authority_channel_live=True,
                          spawn_boundary=lambda:self.fail("unexpected spawn"))
        self.assertEqual(self.h.conn.execute("SELECT COUNT(*) FROM launch").fetchone()[0],0)

    def test_crash_after_intent_and_restart_never_reuses_nonce(self):
        self.assertEqual(self.h.launch(self.ticket(),authority_channel_live=True,
                         spawn_boundary=lambda:self.fail("should not spawn"),crash_after_intent=True),"UNKNOWN")
        self.h.close()
        self.h=SimulatedHostGate(self.path,incarnation="host-boot-A")
        with self.assertRaises(Rejected):
            self.h.launch(self.ticket(),authority_channel_live=True,spawn_boundary=lambda:self.fail("duplicate"))
        self.assertEqual(self.h.conn.execute("SELECT state FROM launch WHERE nonce='n'").fetchone()[0],"INTENT_DURABLE")

    def test_ambiguous_spawn_callback_never_becomes_failed_known(self):
        def crashed():
            raise RuntimeError("host lost ACK after possible spawn")
        self.assertEqual(self.h.launch(self.ticket(),authority_channel_live=True,spawn_boundary=crashed),"UNKNOWN")
        self.assertEqual(self.h.conn.execute("SELECT state FROM launch WHERE nonce='n'").fetchone()[0],"UNKNOWN")
        with self.assertRaises(Rejected):
            self.h.launch(self.ticket(),authority_channel_live=True,spawn_boundary=lambda:self.fail("replay"))

    def test_incarnation_switch_requires_explicit_reenrollment(self):
        self.h.close()
        with self.assertRaises(Rejected):
            SimulatedHostGate(self.path,incarnation="host-boot-B")
        self.h=SimulatedHostGate(self.path,incarnation="host-boot-A")


if __name__ == "__main__":
    unittest.main()
