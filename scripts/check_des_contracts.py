"""Validate complete DES v0.1 reference objects using the bundled strict schema.

This is documentation conformance, NOT authority, OS/Provider qualification, or
an implementation of live profile-bound admission.
"""
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schemas" / "execution-strategy-v0.1.schema.json"
FIXTURES = ROOT / "examples" / "execution-strategies.json"

def check(schema, value, where="$"):
    if "const" in schema and value != schema["const"]:
        raise ValueError(f"{where}: invalid constant")
    allowed = schema.get("type")
    if allowed is not None:
        choices = allowed if isinstance(allowed, list) else [allowed]
        def matches(t):
            return {"object": lambda: type(value) is dict,
                    "array": lambda: type(value) is list,
                    "integer": lambda: type(value) is int,
                    "number": lambda: type(value) in (float,int),
                    "boolean": lambda: type(value) is bool,
                    "string": lambda: type(value) is str,
                    "null": lambda: value is None}[t]()
        if not any(matches(t) for t in choices):
            raise ValueError(f"{where}: wrong type")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{where}: invalid enum {value!r}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength",0):
            raise ValueError(f"{where}: empty/short string")
        if "pattern" in schema:
            import re
            if not re.fullmatch(schema["pattern"],value):
                raise ValueError(f"{where}: invalid pattern")
    if type(value) in (int,float):
        if "minimum" in schema and value < schema["minimum"]:
            raise ValueError(f"{where}: below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise ValueError(f"{where}: above maximum")
    if isinstance(value, dict):
        for key in schema.get("required",[]):
            if key not in value:
                raise ValueError(f"{where}: missing {key}")
        properties = schema.get("properties",{})
        for key, val in value.items():
            if key in properties:
                check(properties[key],val,where+"."+key)
            elif schema.get("additionalProperties") is False:
                raise ValueError(f"{where}: unknown {key}")
            elif isinstance(schema.get("additionalProperties"),dict):
                check(schema["additionalProperties"],val,where+"."+key)
    if isinstance(value,list) and "items" in schema:
        for j,val in enumerate(value):
            check(schema["items"],val,f"{where}[{j}]")

def qualified_structure(schema, strategy):
    check(schema,strategy)
    digest = strategy["digest"]
    unsigned = {k:v for k,v in strategy.items() if k!="digest"}
    canonical = json.dumps(unsigned,sort_keys=True,separators=(",",":"),ensure_ascii=False)
    expected="sha256:"+hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if digest != expected:
        raise ValueError("strategy.digest: canonical binding mismatch")
    # These conditions do not assert that the live profile/Host will admit it.
    sch=strategy["schedule"]
    if sch["max_concurrent"]["R1"]>1 and not sch["disjoint_scopes"]:
        raise ValueError("unproved R1 concurrency")
    if strategy["wait"]["external_job_wake"]=="bounded_poll":
        if not strategy["wait"]["poll_interval_ms"] or not strategy["wait"]["max_poll_attempts"]:
            raise ValueError("unbounded polling")
    else:
        if strategy["wait"]["poll_interval_ms"] is not None or strategy["wait"]["max_poll_attempts"] is not None:
            raise ValueError("event wake must not silently enable polling")
    term=strategy["terminate"]
    if term["task_deadline_ms"] is not None:
        for key in ("step_deadline_ms","convergence_deadline_ms"):
            if term[key]>term["task_deadline_ms"]:
                raise ValueError("deadline mismatch")
        if strategy["resource"]["admission_timeout_ms"]>term["task_deadline_ms"]:
            raise ValueError("admission timeout exceeds task deadline")
    if term["retry_classes"].get("OutcomeUnknown",0)!=0:
        raise ValueError("cannot automatically retry UNKNOWN")

def must_reject(schema, value):
    try:
        qualified_structure(schema,value)
    except ValueError:
        return
    raise AssertionError("invalid fixture unexpectedly accepted")

def main():
    schema=json.loads(SCHEMA.read_text(encoding="utf-8"))
    values=json.loads(FIXTURES.read_text(encoding="utf-8"))
    if {v["domain_id"] for v in values}!={"coding","video"}:
        raise AssertionError("expected both coding and video fixtures")
    for value in values:
        qualified_structure(schema,value)
        x=copy.deepcopy(value);x["context"]["cache"]["ttl_class"]="bad";must_reject(schema,x)
        x=copy.deepcopy(value);x["verify"]["additional_triggers"]=["risk_triggered"];must_reject(schema,x)
        x=copy.deepcopy(value);x["schedule"]["max_concurrent"]["R2"]=1;must_reject(schema,x)
        x=copy.deepcopy(value);x["progress"]["max_consecutive_no_progress"]=0;must_reject(schema,x)
        x=copy.deepcopy(value);x["terminate"]["retry_classes"]["OutcomeUnknown"]=1
        unsigned={k:v for k,v in x.items() if k!="digest"}
        x["digest"]="sha256:"+hashlib.sha256(json.dumps(unsigned,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        must_reject(schema,x)
        x=copy.deepcopy(value);x["digest"]="sha256:"+"0"*64;must_reject(schema,x)
    print("DES v0.1: 2 full fixtures passed; invalid fields, enums, bounds, unknown retries and digests rejected")

if __name__=="__main__":
    main()
