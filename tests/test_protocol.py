"""Deterministic synthetic G1 fixtures. They do NOT qualify any real Provider/Host."""
import concurrent.futures
import os
import tempfile
import time
import unittest

from kernel_contracts import ChargeBound, Conflict, GatewaySendLedger, Kernel, Rejected, SingleLoop


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, "kernel.db")
        self.k = Kernel(self.path, trusted_bound_issuers=frozenset({"synthetic-test-issuer"}))
        self.k.new_task("t", workspace_digest="source-v1", criteria=("tests",), ceiling_minor=10)

    def tearDown(self):
        self.k.close()
        self.temp.cleanup()

    def bound(self, request, maximum):
        return ChargeBound("synthetic-test-issuer", request, maximum, time.time()+60, True)

    def admit(self, attempt="a", amount=6, step="s", command=None):
        return self.k.admit_attempt(command or "admit:"+attempt, task_id="t", step_id=step,
                                    attempt_id=attempt,request_digest="request:"+attempt,
                                    bound=self.bound("request:"+attempt,amount))

    def evidence(self, **overrides):
        p=dict(task_id="t",criterion_id="tests",plan_epoch=1,workspace_epoch=1,source_digest="source-v1",
               effective_digest="source-v1",receipt_id="synthetic-host-receipt",trusted=True,
               sealed_readonly=True,outputs_disjoint=True,verdict="PASS")
        p.update(overrides)
        return self.k.record_coding_evidence("evidence:"+str(len(overrides)),**p)

    def test_admission_atomic_outbox_and_exact_command_dedup(self):
        b=self.bound("request:a",6)
        result=self.k.admit_attempt("one",task_id="t",step_id="s",attempt_id="a",request_digest="request:a",bound=b)
        self.assertEqual(result["outbox_id"],"model:a")
        self.assertEqual(result,self.k.admit_attempt("one",task_id="t",step_id="s",attempt_id="a",request_digest="request:a",bound=b))
        self.assertEqual(self.k.budget("t")["reserved"],6)
        with self.assertRaises(Conflict):
            self.k.admit_attempt("one",task_id="t",step_id="s",attempt_id="B",request_digest="request:B",bound=self.bound("request:B",2))
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM outbox WHERE id='model:a'").fetchone()[0],1)

    def test_unqualified_bound_is_rejected_without_intent(self):
        bad=ChargeBound("not-qualified", "request:a", 4,time.time()+50,True)
        with self.assertRaises(Rejected):
            self.k.admit_attempt("bad",task_id="t",step_id="s",attempt_id="a",request_digest="request:a",bound=bad)
        with self.assertRaises(Rejected):
            self.k.admit_attempt("missing",task_id="t",step_id="s",attempt_id="a",request_digest="request:a",
                                 bound=ChargeBound("synthetic-test-issuer","request:a",4,time.time()+50,False))
        self.assertEqual(self.k.budget("t")["reserved"],0)
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM outbox").fetchone()[0],0)

    def test_concurrent_budget_admission_is_serializable(self):
        other=Kernel(self.path,trusted_bound_issuers=frozenset({"synthetic-test-issuer"}))
        try:
            def run(pair):
                k,ident=pair
                try:
                    k.admit_attempt("c:"+ident,task_id="t",step_id="s",attempt_id=ident,
                                    request_digest="request:"+ident,bound=self.bound("request:"+ident,7))
                    return "accepted"
                except Rejected:
                    return "rejected"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                outcomes=list(pool.map(run,[(self.k,"a"),(other,"b")]))
            self.assertCountEqual(outcomes,["accepted","rejected"])
            self.assertEqual(self.k.budget("t")["reserved"],7)
        finally:
            other.close()

    def test_gateway_send_marker_survives_restart_without_resend(self):
        path=os.path.join(self.temp.name,"gateway.db")
        g=GatewaySendLedger(path)
        self.assertTrue(g.mark_may_have_sent("a","request:a"))
        g.close()
        g=GatewaySendLedger(path)
        try:
            self.assertFalse(g.mark_may_have_sent("a","request:a"))
            with self.assertRaises(Conflict):
                g.mark_may_have_sent("a","modified")
        finally:
            g.close()

    def test_unknown_attempt_reserves_max_and_replacement_is_distinct(self):
        self.admit(amount=7)
        self.k.provider_unknown("unknown", "a")
        self.assertEqual(self.k.budget("t")["reserved"],7)
        with self.assertRaises(Rejected):
            self.admit("replacement",4)
        self.admit("replacement",3)
        self.assertEqual(self.k.budget("t")["reserved"],10)
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM outbox WHERE kind='K_TO_G'").fetchone()[0],2)

    def test_candidate_wins_by_journal_sequence_without_waiting_for_invoice(self):
        self.admit("a",5)
        self.admit("b",4)
        self.k.provider_unknown("unknown-a", "a")
        with self.assertRaises(Rejected):
            self.k.select_candidate("early",task_id="t",step_id="s")
        self.k.record_candidate("candidate-b",attempt_id="b",response_digest="whole-response-b",complete=True)
        result=self.k.select_candidate("select",task_id="t",step_id="s")
        self.assertEqual(result["selected"],"b")
        self.assertEqual(self.k.budget("t")["reserved"],9) # winner + losing UNKNOWN still held
        self.k.record_candidate("late-a",attempt_id="a",response_digest="whole-response-a",complete=True)
        self.assertEqual(self.k.select_candidate("select-again",task_id="t",step_id="s")["selected"],"b")
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM outbox WHERE kind='K_TO_ORCHESTRATOR'").fetchone()[0],1)

    def test_incomplete_candidate_can_never_be_selected(self):
        self.admit()
        with self.assertRaises(Rejected):
            self.k.record_candidate("partial",attempt_id="a",response_digest="partial",complete=False)
        with self.assertRaises(Rejected):
            self.k.select_candidate("choose",task_id="t",step_id="s")

    def test_authentic_settlement_vs_timeout_and_overrun(self):
        self.admit(amount=6)
        self.k.provider_unknown("unknown", "a")
        with self.assertRaises(Rejected):
            self.k.settle_charge("untrusted",attempt_id="a",billed_minor=0,authenticated=False)
        self.assertEqual(self.k.budget("t")["reserved"],6)
        self.k.settle_charge("settled",attempt_id="a",billed_minor=8,authenticated=True)
        self.assertEqual(self.k.budget("t"),{"ceiling":10,"spent":8,"reserved":0,"enforcement_hold":True})
        with self.assertRaises(Rejected):
            self.admit("b",1)

    def test_tool_read_set_and_risk_boundaries_do_not_require_global_task_cas(self):
        t=self.k.task("t")
        self.admit("a",2) # unrelated journal/attempt does not stale Tool admission
        r=dict(task_id="t",invocation_id="tool1",args_digest="args",nonce="nonce1",
               plan_epoch=t["plan_epoch"],authority_epoch=t["authority_epoch"],
               workspace_epoch=t["workspace_epoch"],risk="R0")
        self.k.admit_tool("tool-ok",**r)
        with self.assertRaises(Rejected):
            self.k.admit_tool("risk",**dict(r,invocation_id="tool2",nonce="nonce2",risk="R2"))
        with self.assertRaises(Rejected):
            self.k.admit_tool("r1",**dict(r,invocation_id="tool3",nonce="nonce3",risk="R1"))
        self.k.host_result("tool1-converged",invocation_id="tool1",status="SUCCEEDED",converged=True,authenticated=True)
        self.k.update_workspace("workspace-change",task_id="t",old_epoch=1,new_digest="source-v2")
        with self.assertRaises(Rejected):
            self.k.admit_tool("stale",**dict(r,invocation_id="tool4",nonce="nonce4"))
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM outbox WHERE kind='K_TO_HOST'").fetchone()[0],1)

    def test_unknown_or_unconverged_physical_effect_blocks_completion_and_stop(self):
        t=self.k.task("t")
        self.k.admit_tool("tool",task_id="t",invocation_id="tool",args_digest="argv",nonce="nonce",
                          plan_epoch=t["plan_epoch"],authority_epoch=t["authority_epoch"],workspace_epoch=1,risk="R0")
        self.evidence()
        with self.assertRaises(Rejected):
            self.k.complete("premature",task_id="t",expected_control_version=0)
        self.k.host_result("ambiguous",invocation_id="tool",status="UNKNOWN",converged=False,authenticated=True)
        self.k.request_stop("cancel",task_id="t",reason="CANCELLED")
        with self.assertRaises(Rejected):
            self.k.finalize_stop("not-converged",task_id="t")
        self.k.host_result("reconcile",invocation_id="tool",status="FAILED",converged=True,authenticated=True)
        self.assertEqual(self.k.finalize_stop("final",task_id="t")["state"],"CANCELLED")
        with self.assertRaises(Rejected):
            self.k.complete("after-stop",task_id="t",expected_control_version=2)

    def test_false_completion_shadow_or_missing_evidence_rejected(self):
        with self.assertRaises(Rejected):
            self.k.complete("no-proof",task_id="t",expected_control_version=0)
        with self.assertRaises(Rejected):
            self.evidence(effective_digest="shadow")
        with self.assertRaises(Rejected):
            self.evidence(sealed_readonly=False)
        with self.assertRaises(Rejected):
            self.evidence(trusted=False)
        self.evidence()
        self.assertEqual(self.k.complete("complete",task_id="t",expected_control_version=0)["state"],"COMPLETED")
        with self.assertRaises(Rejected):
            self.k.request_stop("post",task_id="t",reason="FAILED")
        self.assertEqual(self.k.conn.execute("SELECT COUNT(*) FROM journal WHERE kind='TaskCompleted'").fetchone()[0],1)

    def test_workspace_update_invalidates_old_verification(self):
        self.evidence()
        self.k.update_workspace("change",task_id="t",old_epoch=1,new_digest="source-v2")
        with self.assertRaises(Rejected):
            self.k.complete("stale-proof",task_id="t",expected_control_version=0)
        self.k.record_coding_evidence("fresh",task_id="t",criterion_id="tests",plan_epoch=1,workspace_epoch=2,
             source_digest="source-v2",effective_digest="source-v2",receipt_id="trusted-synthetic-r2",
             trusted=True,sealed_readonly=True,outputs_disjoint=True,verdict="PASS")
        self.assertEqual(self.k.complete("fresh-complete",task_id="t",expected_control_version=0)["state"],"COMPLETED")

    def test_model_binding_invalid_after_workspace_change(self):
        self.admit()
        self.k.update_workspace("edit",task_id="t",old_epoch=1,new_digest="source-v2")
        with self.assertRaises(Rejected):
            self.k.record_candidate("stale-candidate",attempt_id="a",response_digest="whole",complete=True)

    def test_structural_replan_cas_and_criterion_binding(self):
        self.evidence()
        self.assertEqual(self.k.structural_replan("replan",task_id="t",expected_control_version=0)["plan_epoch"],2)
        with self.assertRaises(Conflict):
            self.k.structural_replan("stale",task_id="t",expected_control_version=0)
        with self.assertRaises(Rejected):
            self.k.complete("old-evidence",task_id="t",expected_control_version=1)
        self.evidence(plan_epoch=2)
        self.assertEqual(self.k.complete("complete-new-plan",task_id="t",expected_control_version=1)["state"],"COMPLETED")

    def test_terminal_states_cancel_timeout_failure(self):
        for reason in ("CANCELLED","TIMED_OUT","FAILED"):
            task="task-"+reason
            self.k.new_task(task,workspace_digest="s",criteria=("c",),ceiling_minor=0)
            self.assertEqual(self.k.request_stop("stop:"+task,task_id=task,reason=reason)["state"],"STOPPING_"+reason)
            self.assertEqual(self.k.finalize_stop("done:"+task,task_id=task)["state"],reason)
            with self.assertRaises(Rejected):
                self.k.request_stop("again:"+task,task_id=task,reason=reason)

    def test_one_controller_fast_path_stall_and_deadline(self):
        self.evidence()
        calls=[]
        loop=SingleLoop(self.k,max_decisions=20,max_no_progress=2)
        self.assertEqual(loop.run("t",lambda i: calls.append(i) or "COMPLETE"),"COMPLETED")
        self.assertEqual(calls,[0])
        self.k.new_task("hang",workspace_digest="s",criteria=("c",),ceiling_minor=0)
        self.assertEqual(loop.run("hang",lambda i:"PROGRESS"),"FAILED") # false progress has no journal change
        self.k.new_task("timed",workspace_digest="s",criteria=("c",),ceiling_minor=0)
        self.assertEqual(loop.run("timed",lambda i:"NO_PROGRESS",deadline_monotonic=time.monotonic()-1),"TIMED_OUT")

    def test_unrelated_task_activity_does_not_reset_stall_limit(self):
        self.k.new_task("idle",workspace_digest="x",criteria=("c",),ceiling_minor=0)
        self.k.new_task("busy",workspace_digest="y",criteria=("c",),ceiling_minor=0)
        def unrelated_write(i):
            self.k.update_workspace("busy-change-"+str(i),task_id="busy",old_epoch=i+1,new_digest="y"+str(i))
            return "PROGRESS"
        loop=SingleLoop(self.k,max_decisions=10,max_no_progress=2)
        self.assertEqual(loop.run("idle",unrelated_write),"FAILED")

    def test_known_outcome_and_late_process_convergence_are_independent(self):
        t=self.k.task("t")
        self.k.admit_tool("tool",task_id="t",invocation_id="i",args_digest="args",nonce="n",
            plan_epoch=t["plan_epoch"],authority_epoch=t["authority_epoch"],workspace_epoch=t["workspace_epoch"],risk="R0")
        self.k.host_result("success",invocation_id="i",status="SUCCEEDED",converged=False,authenticated=True)
        with self.assertRaises(Rejected):
            self.k.complete("too-early",task_id="t",expected_control_version=0)
        self.k.host_result("converged",invocation_id="i",status="SUCCEEDED",converged=True,authenticated=True)
        self.evidence()
        self.assertEqual(self.k.complete("done",task_id="t",expected_control_version=0)["state"],"COMPLETED")
        with self.assertRaises(Rejected):
            self.k.host_result("conflicting",invocation_id="i",status="FAILED",converged=True,authenticated=True)

    def test_workspace_cutover_blocks_pending_tool(self):
        t=self.k.task("t")
        self.k.admit_tool("tool",task_id="t",invocation_id="i",args_digest="args",nonce="n",
            plan_epoch=t["plan_epoch"],authority_epoch=t["authority_epoch"],workspace_epoch=t["workspace_epoch"],risk="R0")
        with self.assertRaises(Rejected):
            self.k.update_workspace("unsafe",task_id="t",old_epoch=1,new_digest="v2")
        self.k.host_result("done",invocation_id="i",status="SUCCEEDED",converged=True,authenticated=True)
        self.assertEqual(self.k.update_workspace("safe",task_id="t",old_epoch=1,new_digest="v2")["workspace_epoch"],2)

    def test_hard_budget_unrelated_task_has_separate_scope(self):
        self.admit(amount=10)
        self.k.new_task("unrelated",workspace_digest="s",criteria=("c",),ceiling_minor=2)
        self.k.admit_attempt("other",task_id="unrelated",step_id="step-other",attempt_id="other",request_digest="req",
                             bound=self.bound("req",2))
        self.assertEqual(self.k.budget("unrelated")["reserved"],2)


if __name__ == "__main__":
    unittest.main()
