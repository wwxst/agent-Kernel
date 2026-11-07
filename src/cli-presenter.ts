/**
 * CLI 展示层：把真实的 Run 事件排成可读的阶段和工具日志。
 *
 * 台词只给用户看，不写入 Transcript，不参与模型决策；同一阶段轮换短句，
 * 让语气有变化而不假装知道模型在想什么。详细模式展开的是工具真实返回值。
 */
import type { ToolCall } from "./types.ts";

const MOODS = ["energetic", "playful", "tsundere", "curious", "gentle", "confident"] as const;
export type AgentVoice = (typeof MOODS)[number] | "balanced";
export type AgentView = "compact" | "detailed";

type Mood = (typeof MOODS)[number];
type Scene = "preparing" | "thinking" | "reviewing" | "working" | "answering" | "completed" | "failed" | "cancelled";
type Phrase = { mood: Mood; line: string };

// 六种元素：元气、调皮、傲娇、好奇、温柔、可靠。高频阶段各备两轮，避免反复刷屏同一句。
const PHRASES: Record<Scene, readonly Phrase[]> = {
  preparing: [
    { mood: "energetic", line: "任务接住啦，元气启动！" },
    { mood: "playful", line: "嘿嘿，让我看看今天有什么挑战~" },
    { mood: "tsundere", line: "哼，这点准备工作难不倒我。" },
    { mood: "curious", line: "新任务？好想快点解开它！" },
    { mood: "gentle", line: "收到，我会一步步来。" },
    { mood: "confident", line: "先理好路线，再稳稳出发。" },
  ],
  thinking: [
    { mood: "energetic", line: "小脑瓜正在全速转动！" },
    { mood: "playful", line: "线索躲哪儿了？被我找到就糟糕咯~" },
    { mood: "tsundere", line: "才、才不是在发呆，我在分析啦！" },
    { mood: "curious", line: "这个细节有点意思，让我想想。" },
    { mood: "gentle", line: "先理清思路，不着急。" },
    { mood: "confident", line: "把关键点排好队就清楚了。" },
    { mood: "energetic", line: "好，下一条线索，冲呀！" },
    { mood: "playful", line: "嘘，灵感快冒出来了~" },
    { mood: "tsundere", line: "我可没有卡住，只是在认真推敲！" },
    { mood: "curious", line: "要是换个角度看呢？" },
    { mood: "gentle", line: "让我再确认一下思路。" },
    { mood: "confident", line: "逐个排除，答案会更清晰。" },
  ],
  reviewing: [
    { mood: "energetic", line: "工具回来了，继续拼图！" },
    { mood: "playful", line: "哎呀，刚刚的结果藏着什么呢~" },
    { mood: "tsundere", line: "哼，还得再核对一眼才行。" },
    { mood: "curious", line: "有新发现，下一步怎么走？" },
    { mood: "gentle", line: "把刚才的结果串起来看看。" },
    { mood: "confident", line: "有了实测信息，继续判断。" },
    { mood: "energetic", line: "再来一轮，离目标更近啦！" },
    { mood: "playful", line: "线索已经露出小尾巴了~" },
    { mood: "tsundere", line: "只是谨慎一点，别误会哦。" },
    { mood: "curious", line: "这个结果还值得追问一下。" },
    { mood: "gentle", line: "下一步也慢慢核实。" },
    { mood: "confident", line: "先看证据，再决定动作。" },
  ],
  working: [
    { mood: "energetic", line: "工具小队，出动！" },
    { mood: "playful", line: "嘿咻，这一步交给工具啦~" },
    { mood: "tsundere", line: "哼，动手的时候我可认真了。" },
    { mood: "curious", line: "看看实际执行会发现什么。" },
    { mood: "gentle", line: "正在执行，结果马上会记录。" },
    { mood: "confident", line: "按顺序执行，不跳步骤。" },
    { mood: "energetic", line: "继续开工，保持节奏！" },
    { mood: "playful", line: "工具箱里又拿出一招~" },
    { mood: "tsundere", line: "可不是乱点的，步骤都记着呢！" },
    { mood: "curious", line: "这次工具会给出什么线索？" },
    { mood: "gentle", line: "一条一条来，别漏了。" },
    { mood: "confident", line: "执行与结果分开记录。" },
  ],
  answering: [
    { mood: "energetic", line: "整理好啦，开始汇报！" },
    { mood: "playful", line: "答案准备登场，锵锵~" },
    { mood: "tsundere", line: "就、就顺便给你总结一下吧。" },
    { mood: "curious", line: "现在把发现讲清楚。" },
    { mood: "gentle", line: "我把结果慢慢说给你听。" },
    { mood: "confident", line: "用实际结果说话。" },
  ],
  completed: [
    { mood: "energetic", line: "收工！今天也有好好努力！" },
    { mood: "playful", line: "完成啦，偷偷比个耶~" },
    { mood: "tsundere", line: "哼，做完了，才没想讨夸奖呢。" },
    { mood: "curious", line: "这次探索到这里告一段落。" },
    { mood: "gentle", line: "完成了，辛苦啦。" },
    { mood: "confident", line: "本轮已完成，记录都在。" },
  ],
  failed: [
    { mood: "energetic", line: "哎呀没跑完，先把问题记清楚！" },
    { mood: "playful", line: "这次被难住了，错误可不会藏起来哦。" },
    { mood: "tsundere", line: "哼，出错也要堂堂正正报告！" },
    { mood: "curious", line: "有个阻碍，先看看具体原因。" },
    { mood: "gentle", line: "没能完成，原因会如实显示。" },
    { mood: "confident", line: "本轮失败，保留已执行记录。" },
  ],
  cancelled: [
    { mood: "energetic", line: "收到停止信号，马上收手！" },
    { mood: "playful", line: "好哦，工具箱先合上啦~" },
    { mood: "tsundere", line: "哼，说停就停，我很守规矩的。" },
    { mood: "curious", line: "这次先停在这里。" },
    { mood: "gentle", line: "已停止，不会再启动新步骤。" },
    { mood: "confident", line: "取消已记录，本轮未完成。" },
  ],
};

const SCENE_OFFSET: Record<Scene, number> = {
  preparing: 0,
  thinking: 1,
  reviewing: 2,
  working: 3,
  answering: 4,
  completed: 5,
  failed: 2,
  cancelled: 4,
};

/** 只展示常见的目标参数，避免把 write/edit 的文件正文印到进度日志里。 */
function describeTarget(call: ToolCall): string {
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch {
    return "";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const args = value as Record<string, unknown>;
  const target = args.path ?? args.pattern ?? args.command;
  if (typeof target !== "string" || target.length === 0) return "";
  const inline = target.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 90);
  return " · " + inline + (target.length > 90 ? "…" : "");
}

/** 终端日志不应接受结果中的 ESC 控制序列，防止工具输出伪造状态或改写屏幕。 */
function safeText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ");
}

function elapsedTime(startedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((performance.now() - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? minutes + "分" + seconds + "秒" : seconds + "秒";
}

/**
 * Run 的纯展示状态：阶段由内核事件触发，不靠计时器猜测进度。
 * compact 保留每条工具的一行摘要；detailed 把每条返回独立展开，最多展示 4K 字符并注明截断。
 */
export class RunPresenter {
  private readonly startedAt = performance.now();
  private readonly view: AgentView;
  private readonly voice: AgentVoice;
  private readonly sceneCounts: Record<Scene, number> = {
    preparing: 0, thinking: 0, reviewing: 0, working: 0,
    answering: 0, completed: 0, failed: 0, cancelled: 0,
  };
  private toolCalls = 0;
  private streamOpen = false;
  private streamedCurrentStep = false;

  constructor(view: AgentView, voice: AgentVoice) {
    this.view = view;
    this.voice = voice;
  }

  private phrase(scene: Scene): string {
    const all = PHRASES[scene];
    const filtered = this.voice === "balanced" ? all : all.filter((entry) => entry.mood === this.voice);
    const index = this.sceneCounts[scene]++;
    const offset = this.voice === "balanced" ? SCENE_OFFSET[scene] : 0;
    return filtered[(index + offset) % filtered.length].line;
  }

  private status(label: string, scene: Scene, suffix = ""): void {
    this.closeStreamLine();
    console.log(label + (suffix ? " · " + suffix : "") + " 丨 " + this.phrase(scene));
  }

  private closeStreamLine(): void {
    if (this.streamOpen) process.stdout.write("\n");
    this.streamOpen = false;
  }

  start(): void {
    this.status("◇ Preparing", "preparing");
  }

  thinking(step: number): void {
    this.streamedCurrentStep = false;
    this.status("✻ Thinking...", this.toolCalls === 0 ? "thinking" : "reviewing", "step " + step);
  }

  toolStart(call: ToolCall): void {
    this.toolCalls++;
    this.status("⚙ Tool #" + this.toolCalls, "working", call.function.name + describeTarget(call));
  }

  toolResult(call: ToolCall, result: string): void {
    const output = safeText(result);
    const firstLine = output.split("\n", 1)[0] ?? "";
    const excerpt = firstLine.slice(0, 120);
    const truncated = firstLine.length > 120 || output.includes("\n");
    const failed = result.startsWith("ERROR:");
    console.log("  ↳ " + call.function.name + (failed ? " ✗ " : " ✓ ") + excerpt + (truncated ? "…" : ""));

    if (this.view === "detailed") {
      console.log("    ┌ result");
      const shown = output.slice(0, 4000);
      for (const line of shown.split("\n")) console.log("    │ " + line);
      if (output.length > shown.length) {
        console.log("    │ … " + (output.length - shown.length) + " chars omitted");
      }
      console.log("    └ end");
    }
  }

  delta(text: string): void {
    if (!this.streamOpen) {
      this.status("✎ Answering...", "answering");
      process.stdout.write("\n");
      this.streamOpen = true;
    }
    this.streamedCurrentStep = true;
    process.stdout.write(text);
  }

  finalAnswer(content: string): void {
    this.closeStreamLine();
    if (!this.streamedCurrentStep) console.log("\n" + content);
  }

  finish(toolCalls: number, cancelled = false, failed = false): void {
    const scene = cancelled ? "cancelled" : failed ? "failed" : "completed";
    const label = cancelled ? "◌ Cancelled" : failed ? "✕ Failed" : "✓ Completed";
    this.status(label, scene, "用时 " + elapsedTime(this.startedAt) + " · " + toolCalls + " 次工具调用");
  }
}
