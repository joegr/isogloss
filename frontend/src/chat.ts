/** "Ask" panel: streams /api/chat (SSE) and shades each sentence by the model's uncertainty. */

interface Sentence { text: string; level: "low" | "medium" | "high"; entropy: number | null; unsupported: string[] }
interface Done {
  answer: string; sentences: Sentence[];
  uncertainty: { mean_entropy: number | null; measured: boolean; abstained: boolean; tool_gate_used: boolean };
  limits: { steps: number; tool_calls: number; elapsed_s: number; stopped_by: string };
  model: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const linkify = (s: string) =>
  esc(s).replace(/\[(record|contact):([\w-]+)\]/g, (_m, k: string, id: string) =>
    `<a class="cite" href="#/${k === "record" ? "record" : "contacts"}/${id}">${k === "record" ? "↗" : "👤"}</a>`);

export function initChat(): void {
  const $ = (id: string) => document.getElementById(id)!;
  const panel = $("chat-panel"), log = $("chat-log"), form = $("chat-form") as HTMLFormElement;
  const input = $("chat-input") as HTMLTextAreaElement, opener = $("chat-open");
  const history: { role: string; content: string }[] = [];
  let busy = false;

  const toggle = (open: boolean) => {
    panel.hidden = !open;
    opener.setAttribute("aria-expanded", String(open));
    if (open) {
      input.focus();
      fetch("/api/chat/status").then((r) => r.json()).then((s) => {
        $("chat-model").textContent = s.ready ? s.model : `${s.model}: ${s.error ?? "not ready"}`;
      }).catch(() => undefined);
    }
  };
  opener.addEventListener("click", () => toggle(Boolean(panel.hidden)));
  $("chat-close").addEventListener("click", () => toggle(false));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    input.value = "";
    log.insertAdjacentHTML("beforeend", `<li class="msg user">${esc(q)}</li>`);
    const li = document.createElement("li");
    li.className = "msg bot";
    li.innerHTML = `<div class="steps"></div><div class="answer streaming"></div><div class="meta"></div>`;
    log.append(li);
    const steps = li.querySelector(".steps")!, ans = li.querySelector<HTMLElement>(".answer")!;
    const step = (t: string) => steps.insertAdjacentHTML("beforeend", `<div>${esc(t)}</div>`);
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
          if (!data) continue;
          const ev = JSON.parse(data);
          if (ev.type === "grounding") step(`retrieved ${ev.records.length} records${ev.places.length ? " near " + ev.places.join(", ") : ""}`);
          else if (ev.type === "step") ans.textContent = "";
          else if (ev.type === "tool_call") step(`→ ${ev.name}(${Object.values(ev.args ?? {}).filter(Boolean).join(", ")})`);
          else if (ev.type === "tool_blocked") step(`⊘ ${ev.name ?? ev.calls?.join(",")}: ${ev.reason}`);
          else if (ev.type === "token") ans.textContent += ev.text;
          else if (ev.type === "error") throw new Error(ev.message);
          else if (ev.type === "done") render(li, ev as Done, q, history);
        }
      }
    } catch (err) {
      ans.classList.remove("streaming");
      ans.innerHTML = `<span class="chat-error">${esc(String((err as Error).message ?? err))}</span>`;
    } finally {
      busy = false;
      log.scrollTop = log.scrollHeight;
    }
  });
}

function render(li: HTMLElement, d: Done, q: string, history: { role: string; content: string }[]): void {
  const ans = li.querySelector<HTMLElement>(".answer")!;
  ans.classList.remove("streaming");
  ans.innerHTML = d.sentences.length
    ? d.sentences.map((s) => {
        const tip = [s.entropy != null ? `entropy ${s.entropy} bits` : "", s.unsupported.length ? `not in sources: ${s.unsupported.join(", ")}` : ""]
          .filter(Boolean).join(" · ");
        return `<span class="sent u-${s.level}"${tip ? ` title="${esc(tip)}"` : ""}>${linkify(s.text)}</span> `;
      }).join("")
    : linkify(d.answer);
  const u = d.uncertainty;
  li.querySelector(".meta")!.textContent = [
    d.model, `${d.limits.tool_calls} tool calls`, `${d.limits.elapsed_s}s`,
    u.measured ? `mean entropy ${u.mean_entropy} bits` : "entropy n/a",
    u.tool_gate_used ? "uncertain tool call replaced" : "", u.abstained ? "abstained" : "",
    d.limits.stopped_by !== "answer" ? `stopped: ${d.limits.stopped_by}` : "",
  ].filter(Boolean).join(" · ");
  history.push({ role: "user", content: q }, { role: "assistant", content: d.answer });
}
