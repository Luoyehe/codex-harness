import { Icon } from './Icon';
export function Welcome({
  projectName,
  onSuggestion,
}: {
  projectName?: string;
  onSuggestion: (text: string) => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-emblem" aria-hidden="true">
        ⌘
      </div>
      <h1>新会话</h1>
      <div className="suggestions">
        <button onClick={() => onSuggestion('帮我熟悉这个项目，梳理结构与主要模块。')}>
          <span className="suggestion-icon blue">
            <Icon name="folder" />
          </span>
          <strong>了解项目</strong>
        </button>
        <button
          onClick={() => onSuggestion('帮我排查一个问题。先了解相关代码，再一起确认修复方案。')}
        >
          <span className="suggestion-icon amber">⌁</span>
          <strong>解决问题</strong>
        </button>
        <button onClick={() => onSuggestion('我想实现一个新功能，请先和我明确目标与边界。')}>
          <span className="suggestion-icon green">
            <Icon name="plus" />
          </span>
          <strong>实现功能</strong>
        </button>
      </div>
      <div className="welcome-project">
        <Icon name="folder" size={15} />
        {projectName ?? '请先添加服务器上的项目目录'}
      </div>
    </div>
  );
}
