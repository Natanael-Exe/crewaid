import type { VisualTimelineBlock, VisualTimelineStatus } from '@crewaid/shared';
import { Timeline } from '../ui';
import type { TimelineStatus } from '../ui/Timeline';

const STATUS_MAP: Record<VisualTimelineStatus, TimelineStatus> = {
  done: 'complete',
  active: 'current',
  upcoming: 'default',
  blocked: 'error',
};

export function TimelineBlock({ block }: { readonly block: VisualTimelineBlock }) {
  return (
    <section data-visual-block="timeline" className="flex flex-col gap-2.5">
      {block.title !== undefined ? (
        <h4 className="m-0 text-footnote font-medium text-muted">{block.title}</h4>
      ) : null}
      <Timeline density="compact" size="sm">
        {block.items.map((item, idx) => (
          <Timeline.Item
            key={`${item.date}-${item.title}-${idx}`}
            status={item.status !== undefined ? STATUS_MAP[item.status] : 'default'}
          >
            <Timeline.Rail />
            <Timeline.Content>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-footnote font-medium text-foreground">{item.title}</span>
                <span className="shrink-0 text-micro tabular-nums text-muted">{item.date}</span>
              </div>
              {item.detail !== undefined ? (
                <p className="m-0 mt-0.5 text-caption leading-snug text-muted">{item.detail}</p>
              ) : null}
            </Timeline.Content>
          </Timeline.Item>
        ))}
      </Timeline>
    </section>
  );
}
