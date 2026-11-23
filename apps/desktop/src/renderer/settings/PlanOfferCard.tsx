import { Button } from '@heroui/react';
import { IconCheck } from '@tabler/icons-react';
import type { PurchasablePlan } from '@crewaid/shared';
import type { PlanOffer } from './billingState';

/**
 * One plan an account without one can buy. The sign-up gate and
 * Plan & usage draw the same card, so the plan someone is sold after sign-up
 * reads exactly like the one they come back to change.
 */
export function PlanOfferCard({
  offer,
  busy,
  onChoose,
}: {
  readonly offer: PlanOffer;
  readonly busy: boolean;
  readonly onChoose: (plan: PurchasablePlan) => void;
}) {
  return (
    <li className="crewaid-plan-option h-full" data-recommended={offer.recommended}>
      <div className="min-h-[68px]">
        <div className="text-body font-semibold">{offer.title}</div>
        <div className="mt-3 flex flex-wrap items-center gap-x-1.5 tabular-nums">
          <span className="crewaid-plan-price leading-none">{offer.price}</span>
          <span className="text-caption text-muted">{offer.then}</span>
        </div>
      </div>
      <Button
        variant={offer.recommended ? 'primary' : 'secondary'}
        isDisabled={busy}
        onPress={() => onChoose(offer.plan)}
        className="h-10 w-full shrink-0 text-footnote font-medium"
      >
        {offer.cta}
      </Button>
      <ul className="flex flex-1 flex-col gap-2.5 text-footnote leading-[18px]">
        {offer.points.map((point) => (
          <li key={point} className="flex gap-2.5">
            <IconCheck className="mt-px size-4 shrink-0 text-muted" stroke={1.8} aria-hidden />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}
