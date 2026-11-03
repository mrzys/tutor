import { createMemo } from "solid-js";
import { MathText } from "./Paper";
import { reviewMessageText } from "./review-message";

/** Inline, read-only review copy. MathText owns escaping and trust:false KaTeX;
 * the message is never parsed as arbitrary HTML or written back to storage. */
export function ReviewMessage(props: { text: unknown; class?: string }) {
  const text = createMemo(() => reviewMessageText(props.text));
  return <span class={props.class ? `review-message ${props.class}` : "review-message"}><MathText text={text()} /></span>;
}
