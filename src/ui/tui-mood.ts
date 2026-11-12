/**
 * 只负责 TUI 的临时状态语气，不参与模型提示词、Agent 状态或工具权限。
 * 台词是情绪化的等待提示，不代表模型实际思考内容或执行结果。
 */
export type MoodLanguage = "zh" | "en";
export type MoodState =
  | "preparing" | "thinking" | "reading" | "searching" | "editing"
  | "writing" | "running" | "working" | "failed"
  | "completed" | "cancelled";

type Trait = "genki" | "playful" | "curious" | "gentle" | "serious" | "tsundere" | "shy" | "natural";
type Phrase = readonly [Trait, string];
type Pools = Record<MoodState, readonly Phrase[]>;

// 人格的稳定底色偏向元气、机灵、好奇和温柔；傲娇/天然/害羞是低频点缀。
// 权重只是产品初始设计，不是人群喜好的统计数据。
const TRAIT_WEIGHT: Record<Trait, number> = {
  genki: 25, playful: 20, curious: 18, gentle: 15,
  serious: 10, tsundere: 7, shy: 3, natural: 2,
};

const ZH: Pools = {
  preparing: [
    ["genki", "好啦，准备开工～"], ["genki", "先活动一下小脑瓜～"],
    ["curious", "看看今天要做什么呀"], ["gentle", "先理清楚任务再开始"],
    ["playful", "哼哼，准备就绪啦"], ["serious", "我先确认一下目标"],
    ["natural", "唔，从哪里开始呢？"], ["tsundere", "哼，交给我看看吧"],
  ],
  thinking: [
    ["genki", "脑袋瓜转起来啦～"], ["genki", "好，认真想一想！"],
    ["genki", "思路正在冒泡泡～"], ["genki", "灵感快来集合呀～"],
    ["genki", "让我把想法排排队"], ["genki", "这题有点意思呢！"],
    ["playful", "嘿嘿，先让我琢磨琢磨"], ["playful", "思路别乱跑呀～"],
    ["playful", "让我悄悄捋一捋"], ["playful", "唔，小脑瓜开会中"],
    ["playful", "这里值得多想两秒"], ["playful", "再绕个弯想想看～"],
    ["curious", "咦？还有什么可能呢"], ["curious", "换个角度看看呀"],
    ["curious", "让我把线索串起来"], ["curious", "这个问题藏着什么呢"],
    ["curious", "还有没有漏掉的细节？"], ["curious", "嗯……有点意思！"],
    ["gentle", "让我慢慢理清楚呀"], ["gentle", "不着急，先想清楚"],
    ["gentle", "稍微整理一下思路～"], ["serious", "先确认关键条件"],
    ["serious", "仔细核对一下逻辑"], ["serious", "先想清楚边界情况"],
    ["tsundere", "哼，这可难不倒我"], ["tsundere", "才不是在发呆呢！"],
    ["shy", "唔，让我再想想嘛"], ["natural", "欸？思路绕了个圈～"],
  ],
  reading: [
    ["genki", "来啦，翻翻这里～"], ["genki", "读文件时间到！"],
    ["genki", "让我看一眼这里"], ["playful", "嘿嘿，看看藏了什么"],
    ["playful", "文件里的秘密在哪呢"], ["playful", "我来翻一翻呀～"],
    ["curious", "这里写了些什么呢？"], ["curious", "我想仔细瞧瞧～"],
    ["curious", "先看看文件内容"], ["curious", "这部分值得看一下"],
    ["gentle", "先读明白再动手"], ["gentle", "让我认真看一看"],
    ["serious", "先核对文件内容"], ["serious", "逐行确认一下"],
    ["tsundere", "只是顺手看看而已"], ["natural", "咦，打开看看～"],
  ],
  searching: [
    ["genki", "开始找线索啦～"], ["genki", "搜寻模式启动！"],
    ["genki", "目标，快出现吧！"], ["playful", "小线索藏哪儿啦？"],
    ["playful", "哼哼，别想躲过去"], ["playful", "让我翻翻代码角落"],
    ["playful", "捉迷藏开始咯～"], ["curious", "线索会在哪儿呢？"],
    ["curious", "顺着引用找找看"], ["curious", "这里会有答案吗？"],
    ["curious", "再搜搜相关位置"], ["gentle", "一点点查找就好"],
    ["gentle", "沿着线索慢慢找"], ["serious", "定位相关调用中"],
    ["serious", "检查引用关系"], ["tsundere", "哼，藏得还挺好嘛"],
  ],
  editing: [
    ["genki", "好嘞，认真调整一下"], ["genki", "代码整理时间到～"],
    ["genki", "来，把这里理顺！"], ["playful", "给代码梳梳头～"],
    ["playful", "这些细节要乖乖的"], ["playful", "轻轻调整这几行"],
    ["curious", "试试更合适的写法"], ["curious", "看看怎样更清楚"],
    ["gentle", "这里要小心改一下"], ["gentle", "慢慢处理这些细节"],
    ["gentle", "让我仔细调整"], ["serious", "保持改动范围明确"],
    ["serious", "谨慎修改相关代码"], ["serious", "边改边核对逻辑"],
    ["tsundere", "才不是随便改的呢"], ["natural", "嘿咻，这里调整一下"],
  ],
  writing: [
    ["genki", "好啦，开始写入～"], ["genki", "把内容好好放进去"], 
    ["playful", "给文件添一点内容～"], ["playful", "文字排排站好呀"],
    ["curious", "看看怎么组织更好"], ["curious", "这里可以写得更清楚"],
    ["gentle", "我来仔细写进去"], ["gentle", "先把内容整理好"],
    ["serious", "核对写入目标"], ["serious", "确认内容准确再写"],
    ["tsundere", "可不是随手乱写哦"], ["natural", "唔，写到这里啦～"],
  ],
  running: [
    ["genki", "好，试着跑起来～"], ["genki", "开始检验成果啦！"],
    ["genki", "小命令出发咯！"], ["playful", "来看看会发生什么"], 
    ["playful", "嘿嘿，让结果说话"], ["playful", "跑一跑才知道嘛"],
    ["curious", "好奇这次的结果呢"], ["curious", "结果会是什么呢？"],
    ["gentle", "让我确认运行结果"], ["gentle", "再仔细检查一次"],
    ["serious", "正在等待实际结果"], ["serious", "检查执行是否正常"],
    ["serious", "先看真实返回值"], ["tsundere", "哼，跑一下就知道"],
    ["natural", "嘿咻，运行一下！"], ["genki", "检验时间到啦～"],
  ],
  working: [
    ["genki", "继续处理下一步～"], ["genki", "好，再接着看看"],
    ["playful", "嘿嘿，还有后续呢"], ["curious", "接下来会是什么呢"],
    ["curious", "再看看下一步"], ["gentle", "我先整理一下结果"],
    ["gentle", "稍微核对一下"], ["serious", "继续检查当前状态"],
  ],
  failed: [
    ["serious", "先看清楚报错原因"], ["serious", "这一步没有通过"],
    ["gentle", "遇到阻碍，先检查原因"], ["serious", "先定位失败位置"],
    ["gentle", "先看看具体错误"], ["serious", "检查返回的错误信息"],
  ],
  completed: [
    ["genki", "这轮处理结束啦～"], ["genki", "好啦，结果整理好了"],
    ["playful", "哼哼，收工时间到"], ["gentle", "接下来看看结果吧"],
    ["serious", "任务已结束，结果可查"], ["tsundere", "才没有很得意呢"],
  ],
  cancelled: [
    ["gentle", "这一步已经停下了"], ["serious", "操作已停止"],
    ["gentle", "保留已经完成的部分"], ["serious", "不再继续执行"],
  ],
};

const EN: Pools = {
  preparing: [
    ["genki", "All set, here we go!"], ["curious", "Where shall I start?"],
    ["gentle", "Let's get things in order."], ["serious", "Checking the task first."],
  ],
  thinking: [
    ["genki", "Little gears are turning!"], ["genki", "Ideas, line up please!"],
    ["genki", "Let me put this together."], ["playful", "A tiny puzzle to untangle~"],
    ["playful", "Hold on, clever thought incoming."], ["playful", "Time to connect the dots!"],
    ["curious", "Ooh, another angle?"], ["curious", "What am I missing here?"],
    ["curious", "Let's follow the clues."], ["gentle", "One thought at a time."],
    ["gentle", "Let me sort this through."], ["serious", "Checking the edge cases."],
    ["serious", "Keeping the logic straight."], ["tsundere", "I wasn't spacing out!"],
    ["shy", "Just a little more thought~"], ["natural", "Hmm, that took a turn!"],
  ],
  reading: [
    ["genki", "Let's take a peek!"], ["playful", "What's hiding in here?"],
    ["playful", "A little file detective work~"], ["curious", "Let's read this carefully."],
    ["curious", "What's in this file?"], ["gentle", "Reading before changing."],
    ["serious", "Checking the file contents."], ["tsundere", "Just a quick look, okay?"],
  ],
  searching: [
    ["genki", "Clue hunt begins!"], ["playful", "Come out, little clues!"],
    ["playful", "No hiding from me~"], ["curious", "Where does this lead?"],
    ["curious", "Following the references."], ["gentle", "Searching one step at a time."],
    ["serious", "Locating relevant code."], ["tsundere", "Not so well hidden, huh?"],
  ],
  editing: [
    ["genki", "Time to tidy this up!"], ["playful", "A little code makeover~"],
    ["playful", "Easy does it, code!"], ["curious", "Let's make this clearer."],
    ["gentle", "Changing this carefully."], ["gentle", "One small edit at a time."],
    ["serious", "Keeping the diff focused."], ["tsundere", "I'm not changing it blindly!"],
  ],
  writing: [
    ["genki", "Let's write this down!"], ["playful", "Into the file you go~"],
    ["curious", "Let's organize this neatly."], ["gentle", "Writing with care."],
    ["serious", "Checking what gets written."],
  ],
  running: [
    ["genki", "Let's give it a run!"], ["genki", "Test time!"],
    ["playful", "Let's see what happens~"], ["curious", "Wonder what the output says?"],
    ["gentle", "Checking the actual result."], ["serious", "Waiting for the process output."],
    ["serious", "Verifying the command result."], ["tsundere", "We'll see when it runs!"],
  ],
  working: [
    ["genki", "On to the next step!"], ["playful", "There's more to do~"],
    ["curious", "Let's see what's next."], ["gentle", "Checking the result."],
    ["serious", "Processing the latest event."],
  ],
  failed: [
    ["serious", "Let's inspect the error."], ["gentle", "Checking what went wrong."],
    ["serious", "The operation did not pass."],
  ],
  completed: [
    ["genki", "All wrapped up!"], ["gentle", "Ready to review the result."],
    ["serious", "The task is finished."],
  ],
  cancelled: [
    ["gentle", "This action has stopped."], ["serious", "Execution is cancelled."],
  ],
};

/** 加权选一句、跳过最近显示的台词。不能据此推断 AI 的真实思考内容。 */
export function selectMood(
  state: MoodState,
  language: MoodLanguage,
  recent: readonly string[] = [],
  random: () => number = Math.random,
): string {
  const pool = (language === "zh" ? ZH : EN)[state];
  const unused = pool.filter(([, phrase]) => !recent.includes(phrase));
  const choices = unused.length > 0 ? unused : pool;
  const total = choices.reduce((sum, [trait]) => sum + TRAIT_WEIGHT[trait], 0);
  let cursor = Math.max(0, Math.min(0.999999, random())) * total;
  for (const [trait, phrase] of choices) {
    cursor -= TRAIT_WEIGHT[trait];
    if (cursor < 0) return phrase;
  }
  return choices[choices.length - 1]![1];
}
