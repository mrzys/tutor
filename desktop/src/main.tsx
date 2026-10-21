import { render } from "solid-js/web";
import App from "./App";
import "./tokens.css";
import "katex/dist/katex.min.css";
import "./styles.css";

document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab")
      document.documentElement.dataset.inputMode = "keyboard";
  },
  true,
);
document.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.inputMode = "pointer";
  },
  true,
);
render(() => <App />, document.getElementById("root")!);
