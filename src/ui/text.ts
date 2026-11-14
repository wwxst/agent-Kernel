/**
 * 文件目的：把终端输出里那些「看不见、却能控制屏幕」的字符，变成看得见的符号。
 *
 * 不做这一步，工具输出里的特殊字符就能改写屏幕：把一次失败画成成功、
 * 把一段命令伪装成提示符。用户看到的就不是真实结果。
 *
 * 文件职责：负责把控制字符转成 `\uXXXX` 形式的可见转义。
 * 不负责换行 —— 换行由调用方按行拆开并加前缀，既保留多行文本，又不让内容伪造提示符。
 *
 * 内容目录：
 *   - `escapeControlCharacters()`：唯一的导出，把危险字符转成可见转义。
 *
 * 模块关系：不依赖任何模块，是依赖图里的叶子。被 `ui/tui.ts` 与 `ui/cli-presenter.ts`
 * 调用，用来洗一遍即将打印到屏幕上的文本。
 */

/**
 * 界面函数 escapeControlCharacters（转义控制字符）：把终端展示文本里的控制字符转成看得见的符号，防止它们改写屏幕。
 *
 * 换行不在这里处理：调用方按行拆开并加前缀，既保留多行文本，又不让内容伪造提示符。
 * 除换行外的 C0/C1、DEL、Unicode 行分隔符和 bidi 控制字符一律转义。
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}
