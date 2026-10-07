import { Link } from 'react-router-dom';

const ICONS = { warning: '!', info: 'i', good: '✓' };

export function InsightCard({ insight }) {
  return (
    <div className={`insight ${insight.tone}`}>
      <span className="insight-icon" aria-hidden="true">{ICONS[insight.tone]}</span>
      <div className="grow">
        <strong>{insight.title}</strong>
        <p className="hint">{insight.detail}</p>
      </div>
      {insight.action && <Link className="insight-action" to={insight.action.to}>{insight.action.label}</Link>}
    </div>
  );
}
