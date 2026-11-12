/**
 * Permission 的单元测试。
 *
 * 这里钉两件事：
 *   1. 三档模式各自放行什么、拒绝什么，尤其是 shell 的「每次都要问」和「默认拒绝」；
 *   2. ToolRegistry 的接入位置 —— 参数校验之后、run 之前。
 *
 * 审批器用假函数注入，不碰 stdin：终端交互本身属于 CLI 的组装，放在 cli.test.mjs 里验证。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PERMISSION_MODE, Permission, approvalGate, isApproved, parsePermissionMode, permissionPrompt } from "../src/permission.ts";
import { ToolRegistry } from "../src/tool-registry.ts";

/** 一次权限检查的请求形状。 */
function request(tool, args = {}) {
  return { tool, args };
}

/** 一个最小工具：只有名字和 run，Schema 用空对象。 */
function tool(name, run = async () => `${name} ran`) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    run,
  };
}

/** shell 的 Schema：command 必填，用来验证「参数校验先于权限」。 */
function shellTool(run = async () => "shell ran") {
  return {
    name: "shell",
    description: "run a command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run,
  };
}

/** 构造一次工具调用（ToolCall 的线上形状）。 */
function call(name, rawArguments = "{}", id = "call_1") {
  return { id, type: "function", function: { name, arguments: rawArguments } };
}

test("Permission：默认是 workspace-write", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "workspace-write");
  assert.equal(new Permission().mode, "workspace-write");
});

test("parsePermissionMode：只认三档，大小写和拼写错误都返回 undefined", () => {
  assert.equal(parsePermissionMode("read-only"), "read-only");
  assert.equal(parsePermissionMode("workspace-write"), "workspace-write");
  assert.equal(parsePermissionMode("full-access"), "full-access");
  for (const value of ["", "readonly", "Read-Only", "workspace_write", "wide-open", " read-only "]) {
    assert.equal(parsePermissionMode(value), undefined);
  }
});

test("isApproved：只有 y / yes（大小写不敏感）算允许", () => {
  for (const answer of ["y", "Y", "yes", "YES", " yes "]) {
    assert.equal(isApproved(answer), true);
  }
  for (const answer of ["", "n", "no", "true", "1", "yes please"]) {
    assert.equal(isApproved(answer), false);
  }
});

test("approvalGate：无 TTY、已取消、已有排队输入时都不提问", () => {
  const controller = new AbortController();

  assert.deepEqual(approvalGate(controller.signal, true, false), { ask: true });
  assert.deepEqual(approvalGate(controller.signal, false, false), {
    ask: false,
    reason: "no interactive terminal",
  });
  // 任务运行时提前打好的下一行不能被当成审批答案。
  assert.deepEqual(approvalGate(controller.signal, true, true), {
    ask: false,
    reason: "next input is already queued",
  });

  controller.abort();
  assert.deepEqual(approvalGate(controller.signal, true, false), {
    ask: false,
    reason: "task cancelled",
  });
});

test("read-only：放行 read/ls/glob/grep，拒绝 write/edit/shell，且不触发审批", async () => {
  let asked = 0;
  const permission = new Permission("read-only", () => {
    asked++;
    return true;
  });

  for (const name of ["read", "ls", "glob", "grep"]) {
    assert.deepEqual(await permission.check(request(name)), { allowed: true });
  }
  for (const name of ["write", "edit", "shell"]) {
    const result = await permission.check(request(name));
    assert.equal(result.allowed, false);
    assert.match(result.reason, /read-only/);
  }
  assert.equal(asked, 0, "只读模式不该为任何工具打断用户");
});

test("workspace-write：读与写工具直接放行，不触发审批", async () => {
  let asked = 0;
  const permission = new Permission("workspace-write", () => {
    asked++;
    return true;
  });

  for (const name of ["read", "ls", "glob", "grep", "write", "edit"]) {
    assert.deepEqual(await permission.check(request(name)), { allowed: true });
  }
  assert.equal(asked, 0);
});

test("workspace-write：shell 每次都要问，批准一次只放行这一次", async () => {
  const seen = [];
  const permission = new Permission("workspace-write", async (req) => {
    seen.push(req);
    return true;
  });

  assert.deepEqual(await permission.check(request("shell", { command: "npm test" })), { allowed: true });
  assert.deepEqual(await permission.check(request("shell", { command: "git status" })), { allowed: true });

  // 第二次仍然问了：没有缓存「上次同意过」。
  assert.deepEqual(
    seen.map((req) => req.args.command),
    ["npm test", "git status"],
  );
});

test("workspace-write：用户拒绝时返回原因", async () => {
  const permission = new Permission("workspace-write", () => false);

  const result = await permission.check(request("shell", { command: "rm -rf ." }));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /user denied/);
});

test("workspace-write：没有审批器时 shell 默认拒绝", async () => {
  const result = await new Permission("workspace-write").check(request("shell", { command: "echo hi" }));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /no approval prompt/);
});

test("workspace-write：审批抛异常按拒绝处理", async () => {
  const permission = new Permission("workspace-write", async () => {
    throw new Error("readline closed");
  });

  const result = await permission.check(request("shell", { command: "echo hi" }));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /readline closed/);
  assert.match(result.reason, /denied by default/);
  assert.doesNotMatch(result.reason, /user denied/);
});

test("workspace-write：审批被取消（AbortError）也按拒绝处理", async () => {
  const permission = new Permission("workspace-write", async () => {
    throw new DOMException("aborted", "AbortError");
  });

  const result = await permission.check(request("shell", { command: "echo hi" }));

  assert.equal(result.allowed, false);
  assert.match(result.reason, /aborted/);
  assert.match(result.reason, /denied by default/);
});

test("异步 Shell 审批中撤权：即使用户后来批准，也不能执行工具", async () => {
  let approve;
  const waitingForApproval = new Promise((resolve) => { approve = resolve; });
  const permission = new Permission("workspace-write", () => waitingForApproval);
  let executed = 0;
  const registry = new ToolRegistry([shellTool(async () => {
    executed++;
    return "executed";
  })], { permission });

  const pending = registry.execute(call("shell", JSON.stringify({ command: "echo blocked" })));
  permission.setMode("read-only");
  approve(true);
  const result = await pending;

  // 拒绝文本必须带「不要重试」，否则模型会换个写法无限重试。
  assert.match(result, /^ERROR: permission denied: permission mode changed during approval; denied\. Do not retry this operation/);
  assert.equal(executed, 0);
  assert.equal(permission.mode, "read-only");
});

test("异步审批期间切走再切回、或切到 full-access：旧批准一律失效", async () => {
  for (const modeChanges of [["read-only", "workspace-write"], ["full-access"]]) {
    let approve;
    const waitingForApproval = new Promise((resolve) => { approve = resolve; });
    const permission = new Permission("workspace-write", () => waitingForApproval);
    const pending = permission.check(request("shell", { command: "echo still-blocked" }));

    for (const mode of modeChanges) permission.setMode(mode);
    approve(true);
    const result = await pending;

    assert.equal(result.allowed, false);
    assert.match(result.reason, /permission mode changed during approval/);
  }
});

test("异步审批期间重复设置同一权限：不撤销有效的单次批准", async () => {
  let approve;
  const waitingForApproval = new Promise((resolve) => { approve = resolve; });
  const permission = new Permission("workspace-write", () => waitingForApproval);
  const pending = permission.check(request("shell", { command: "echo permitted" }));

  permission.setMode("workspace-write");
  approve(true);
  assert.deepEqual(await pending, { allowed: true });
});

test("full-access：所有工具放行，不触发审批", async () => {
  let asked = 0;
  const permission = new Permission("full-access", () => {
    asked++;
    return false;
  });

  for (const name of ["read", "write", "edit", "shell", "future_tool"]) {
    assert.deepEqual(await permission.check(request(name)), { allowed: true });
  }
  assert.equal(asked, 0);
});

test("setMode：切换后立即按新模式判断", async () => {
  const permission = new Permission("workspace-write", () => true);

  permission.setMode("read-only");
  assert.equal((await permission.check(request("write"))).allowed, false);

  permission.setMode("full-access");
  assert.equal((await permission.check(request("write"))).allowed, true);

  permission.setMode("workspace-write");
  assert.equal((await permission.check(request("shell", { command: "echo hi" }))).allowed, true);
});

test("read-only / workspace-write：没分类的工具默认拒绝", async () => {
  for (const mode of ["read-only", "workspace-write"]) {
    const result = await new Permission(mode).check(request("future_tool"));
    assert.equal(result.allowed, false);
  }
});

test("permissionPrompt：三档都说明当前限制，且不混入其他模式", () => {
  const readOnly = permissionPrompt("read-only");
  assert.match(readOnly, /Permission mode: read-only/);
  assert.match(readOnly, /This overrides the base tool list/);
  assert.match(readOnly, /write, edit, and shell are denied/);
  assert.match(readOnly, /skip it and explain why/);
  assert.doesNotMatch(readOnly, /workspace-write|full-access/);

  const workspace = permissionPrompt("workspace-write");
  assert.match(workspace, /Permission mode: workspace-write/);
  assert.match(workspace, /shell requires explicit user approval for every command/);

  const full = permissionPrompt("full-access");
  assert.match(full, /Permission mode: full-access/);
  assert.match(full, /All tools, including shell, may be used without approval/);
});

test("ToolRegistry：权限拒绝返回 ERROR，工具代码不会执行", async () => {
  let ran = false;
  const registry = new ToolRegistry(
    [
      tool("write", async () => {
        ran = true;
        return "wrote";
      }),
    ],
    { permission: new Permission("read-only") },
  );

  const result = await registry.execute(call("write"));

  assert.match(result, /^ERROR: permission denied: /);
  assert.match(result, /read-only/);
  assert.equal(ran, false);
});

test("ToolRegistry：参数校验在权限检查之前，坏参数不会触发审批", async () => {
  let asked = 0;
  let ran = false;
  const registry = new ToolRegistry(
    [
      shellTool(async () => {
        ran = true;
        return "shell ran";
      }),
    ],
    {
      permission: new Permission("workspace-write", () => {
        asked++;
        return true;
      }),
    },
  );

  const result = await registry.execute(call("shell", "{}"));

  assert.match(result, /^ERROR: invalid arguments: missing required argument "command"/);
  assert.equal(asked, 0, "参数都不合法，没理由为它去问用户");
  assert.equal(ran, false);
});

test("ToolRegistry：审批通过后工具才执行", async () => {
  let ran = 0;
  const registry = new ToolRegistry(
    [
      shellTool(async () => {
        ran++;
        return "shell ran";
      }),
    ],
    { permission: new Permission("workspace-write", () => true) },
  );

  const result = await registry.execute(call("shell", JSON.stringify({ command: "echo hi" })));

  assert.equal(result, "shell ran");
  assert.equal(ran, 1);
});

test("ToolRegistry：审批异常折成 ERROR，不会穿出 execute", async () => {
  const registry = new ToolRegistry([shellTool()], {
    permission: new Permission("workspace-write", async () => {
      throw new Error("tty gone");
    }),
  });

  const result = await registry.execute(call("shell", JSON.stringify({ command: "echo hi" })));

  assert.match(result, /^ERROR: permission denied: /);
  assert.match(result, /denied by default/);
});

test("ToolRegistry：permission: null 是显式关闭权限检查", async () => {
  const registry = new ToolRegistry([tool("write")], { permission: null });

  assert.equal(await registry.execute(call("write")), "write ran");
});

test("ToolRegistry：漏传 options 在构造阶段报错", () => {
  assert.throws(
    () => new ToolRegistry([tool("write")]),
    /ToolRegistry: options are required/,
  );
});

test("ToolRegistry：第二参数传 null 在构造阶段报错", () => {
  assert.throws(
    () => new ToolRegistry([tool("write")], null),
    /ToolRegistry: options must be an object; got null/,
  );
});

test("ToolRegistry：permission 字段缺失在构造阶段报错", () => {
  assert.throws(
    () => new ToolRegistry([tool("write")], {}),
    /ToolRegistry: options\.permission is required/,
  );
});

test("ToolRegistry：permission: undefined 在构造阶段报错", () => {
  assert.throws(
    () => new ToolRegistry([tool("write")], { permission: undefined }),
    /ToolRegistry: options\.permission must be a Permission instance or null, got undefined/,
  );
});

test("ToolRegistry：非法 permission 值在构造阶段报错", () => {
  for (const permission of ["full-access", {}, 1, false]) {
    assert.throws(
      () => new ToolRegistry([tool("write")], { permission }),
      /ToolRegistry: options\.permission must be a Permission instance or null/,
    );
  }
});

test("ToolRegistry：未知工具仍按未知工具报错，不会先问权限", async () => {
  let asked = 0;
  const registry = new ToolRegistry([tool("read")], {
    permission: new Permission("workspace-write", () => {
      asked++;
      return true;
    }),
  });

  const result = await registry.execute(call("shell", JSON.stringify({ command: "echo hi" })));

  assert.match(result, /^ERROR: unknown tool "shell"/);
  assert.equal(asked, 0);
});
