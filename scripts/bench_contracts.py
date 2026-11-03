"""Synthetic timing probe. Not an agent-quality or production performance comparison."""
import argparse
import json
import os
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from kernel_contracts import Kernel, SingleLoop


def run(n):
    samples=[]
    with tempfile.TemporaryDirectory() as tmp:
        kernel=Kernel(os.path.join(tmp,"bench.db"))
        try:
            for i in range(n):
                t=time.perf_counter_ns()
                ident=str(i)
                kernel.new_task(ident,workspace_digest="snapshot",criteria=("ok",),ceiling_minor=0)
                kernel.record_coding_evidence("e:"+ident,task_id=ident,criterion_id="ok",plan_epoch=1,
                    workspace_epoch=1,source_digest="snapshot",effective_digest="snapshot",
                    receipt_id="synthetic-proof-"+ident,trusted=True,sealed_readonly=True,
                    outputs_disjoint=True,verdict="PASS")
                status=SingleLoop(kernel,max_decisions=3).run(ident,lambda _:"COMPLETE")
                if status != "COMPLETED":
                    raise RuntimeError("bad terminal state")
                samples.append((time.perf_counter_ns()-t)/1e6)
        finally:
            kernel.close()
    ordered=sorted(samples)
    result={"scenario":"synthetic preloaded one-decision completion, temp-file SQLite",
            "iterations":n,"completed":n,"policy_decisions_per_task":1,"model_requests_per_task":0,
            "tokens_measured":False,"p50_ms":round(statistics.median(samples),4),
            "p95_ms":round(ordered[max(0,int((n-1)*0.95))],4)}
    print(json.dumps(result,sort_keys=True))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--iterations",type=int,default=50)
    args=parser.parse_args()
    if args.iterations<1:
        parser.error("iterations must be positive")
    run(args.iterations)
