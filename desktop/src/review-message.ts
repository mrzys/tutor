import katex from "katex";
import { mathSegments } from "./shared/math-segments.mjs";

// Deliberately limited to ordinary mathematical notation in review messages.
// No macros, HTML, links, file access or arbitrary commands are introduced.
const commands = new Set((`
  int iint iiint oint lim limsup liminf frac dfrac tfrac sqrt binom dbinom tbinom
  alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega
  Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
  sum prod infty partial nabla cdot times div pm mp le leq ge geq ne neq approx equiv sim simeq propto
  in notin subset subseteq supset supseteq cup cap emptyset varnothing forall exists neg
  to rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto
  sin cos tan cot sec csc arcsin arccos arctan log ln exp min max sup inf
  left right overline underline bar hat vec overrightarrow dot ddot
  mathrm mathit mathbf mathcal mathbb operatorname text quad qquad
`).trim().split(/\s+/));

function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
}

// Adding a new pair beside an existing unpaired delimiter could accidentally
// close it. Such damaged messages remain completely visible and unchanged.
function hasUnpairedDelimiter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!escaped(text, i) && (text[i] === "$" || /^\\[()[\]]/.test(text.slice(i, i + 2)))) return true;
  }
  return false;
}

function completeQuotedMath(value: string): boolean {
  const source = value.trim();
  if (!source || source.length > 256 || /[\r\n$%]|\\\\/.test(source) || /^[A-Za-z]:[\\/]/.test(source)
    || /<\/?[A-Za-z][^>]*>|<!--|-->/.test(source)) return false;
  if (!/\\[A-Za-z]+/.test(source)) return false;
  let allowed = true;
  const plain = source.replace(/\\([A-Za-z]+|[,;:! {}])/g, (_raw, command: string) => {
    if (command.length > 1 && !commands.has(command) || command.length === 1 && /[A-Za-z]/.test(command)) allowed = false;
    return "";
  });
  // Ordinary text, filenames, URLs and unmatched backslashes are not formulas.
  if (!allowed || !/^[A-Za-z0-9\s{}()[\]^_+\-=<>.,;:!?|/*']*$/.test(plain)) return false;
  try {
    // Reuse the actual renderer's grammar, rather than guessing argument counts
    // or inventing missing operands for commands such as \frac and \sqrt.
    katex.renderToString(source, { throwOnError: true, trust: false, strict: "ignore", displayMode: false });
    return true;
  } catch {
    return false;
  }
}

/** Read-only display projection. Existing formulas and all unquoted text stay
 * byte-for-byte intact. Only a complete, narrowly allowed quoted expression is
 * given delimiters; persisted messages and their semantic identity are unused. */
export function reviewMessageText(value: unknown): string {
  if (typeof value !== "string") return "";
  return mathSegments(value).map(part => {
    if (part.type === "math" || hasUnpairedDelimiter(part.raw)) return part.raw;
    return part.raw.replace(/“([^“”\r\n]+)”|「([^「」\r\n]+)」|『([^『』\r\n]+)』|"([^"\r\n]+)"|'([^'\r\n]+)'/gu,
      (quoted: string, ...args: any[]) => {
        const content = args.slice(0, 5).find(value => typeof value === "string") as string;
        const at = args[5] as number;
        const prefix = part.raw.slice(Math.max(0, at - 24), at);
        if (/(?:路径|目录|文件名?|URL|URI|命令行)[：:为是\s]*$/i.test(prefix) || !completeQuotedMath(content)) return quoted;
        return `${quoted[0]}\\(${content}\\)${quoted.at(-1)}`;
      });
  }).join("");
}
