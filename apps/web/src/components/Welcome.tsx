import { useStore } from "../store";
import { Icon } from "./Icon";
import { pathBasename } from "../utils/time";

const starters = [
  { icon: "code" as const, title: "理解项目", description: "先看架构，再开始动手", prompt: "请先阅读当前项目，说明它的主要结构、运行方式和关键模块。先不要修改代码。" },
  { icon: "search" as const, title: "检查代码", description: "定位问题，给出可靠证据", prompt: "请审查当前项目中可能存在的 bug 和逻辑问题，列出证据、影响范围与建议。先不要修改代码。" },
  { icon: "spark" as const, title: "实现想法", description: "从一个清晰的需求开始", prompt: "我想在当前项目中实现一个新功能：" },
];

export function Welcome({ onSuggestion }: { onSuggestion?: (text: string) => void }) {
  const project = useStore((s) => s.currentProject);
  const connected = useStore((s) => s.connection === "open");
  return <section className="welcome" aria-label="开始使用">
    <div className="welcome-symbol"><Icon name="code" width="34" height="34" /></div>
    <span className="welcome-eyebrow">CODEX HARNESS · YOUR WORKSPACE</span>
    <h2>从一个想法，开始。</h2>
    <p>读懂项目，解决问题，把计划变成真实的成果。</p>
    <div className="welcome-context"><Icon name="folder" /><span>{project ? "当前工作目录 · " + pathBasename(project) : "先在左侧添加或选择一个项目"}</span></div>
    <div className="starter-grid">
      {starters.map((starter) => <button key={starter.title} className="starter-card" disabled={!onSuggestion}
        onClick={() => onSuggestion?.(starter.prompt)}>
        <Icon name={starter.icon} /><strong>{starter.title}</strong><span>{starter.description}</span><Icon name="chevron" />
      </button>)}
    </div>
    <p className="welcome-note">选择上方起点只会填入草稿，不会自动执行。{!connected && "网关连接后才能发送。"}</p>
  </section>;
}
