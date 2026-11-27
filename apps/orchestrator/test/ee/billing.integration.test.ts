// First: registers the cloud edition's Better Auth plugins (D-238) before
// anything below can build the auth instance. vi.hoisted still runs earlier.
import '../../src/ee/auth/register-cloud-auth.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import Stripe from 'stripe';
import request from 'supertest';
import {
  BillingRedirectResponseSchema,
  BillingResponseSchema,
  CALL_PLAN_REQUIRED_CODE,
  StartCallResponseSchema,
} from '@crewaid/shared';
import { CALL_AGENT_FACTORY, type CallAgent } from '../../src/ee/voice/elevenlabs-agent.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { STRIPE_CLIENT } from '../../src/ee/billing/billing.tokens.js';
import { COMPUTE_POLICY, type ComputePolicy } from '../../src/sandbox/compute-policy.js';
import { SandboxActivityService } from '../../src/sandbox/sandbox-activity.service.js';
import { SandboxIdleService } from '../../src/sandbox/sandbox-idle.service.js';
import { SandboxMeterService } from '../../src/ee/billing/sandbox-meter.service.js';
import { SandboxService } from '../../src/sandbox/sandbox.service.js';
import { SANDBOX_PROVIDER } from '../../src/sandbox/sandbox.provider.js';
import { EventType, type StreamChunk, type TextOptions } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import { TurnEventBus } from '../../src/agent/turn-event.bus.js';
import { IncludedModelsService } from '../../src/ee/billing/included-models.service.js';
import { BillingService } from '../../src/ee/billing/billing.service.js';
import { ModelAllowanceExhaustedError } from '../../src/models/included-models.port.js';
import { ModelResolutionService } from '../../src/models/model-resolution.service.js';
import { signIn, signOutAndDelete, type SignedInUser } from '../auth-fixture.js';
import { privateComputerBot } from '../computer-fixtures.js';
import { FakeProvider } from '../sandbox-fakes.js';

/**
 * D-156 — the hosted service's plans over the real stack: real HTTP, the real
 * guard, the real Better Auth instance with its Stripe plugin, and a real
 * database.
 *
 * Billing is decided from the environment at import, so it is switched on
 * here before anything imports the application. Stripe itself is two things
 * in this suite: the webhook is verified by the plugin's real Stripe client
 * against a signature made with the real SDK, and Checkout and the portal —
 * which would be network calls — go to a fake that records what was asked.
 */
const ENV = vi.hoisted(() => {
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_crewaid_billing_suite',
    STRIPE_WEBHOOK_SECRET: 'whsec_crewaid_billing_suite',
    STRIPE_PRICE_STARTER: 'price_starter_suite',
    STRIPE_PRICE_PRO: 'price_pro_suite',
    // D-157: switches the included models on. Never used to call anyone — the
    // suite puts a scripted model where OpenRouter would be — except by the
    // on-demand live case at the end, which brings its own key.
    CREWAID_OPENROUTER_API_KEY:
      process.env['MODAI11_LIVE_OPENROUTER_KEY'] ?? 'sk-or-crewaid-billing-suite',
    // D-222: switches calls on. The agent is faked below; nothing calls ElevenLabs.
    CREWAID_ELEVENLABS_API_KEY: 'sk_el_billing_suite',
    CREWAID_ELEVENLABS_AGENT_ID: 'agent_billing_suite',
  };
  Object.assign(process.env, env);
  return env;
});

const DATABASE_URL = process.env['DATABASE_URL'];
const RUN_ID = randomUUID().slice(0, 8);

type CheckoutParams = Stripe.Checkout.SessionCreateParams;

/** What the billing service asked Stripe for. */
const stripeCalls = {
  customers: [] as { params: Stripe.CustomerCreateParams; idempotencyKey?: string }[],
  checkouts: [] as CheckoutParams[],
  expired: [] as string[],
  portals: [] as Stripe.BillingPortal.SessionCreateParams[],
};

/**
 * Stripe's side of the world, as the fake holds it: subscriptions by id (what
 * the sync re-reads on every event) and open checkout sessions by customer.
 */
const stripeState = {
  subscriptions: new Map<string, FakeSubscription>(),
  openSessions: [] as { id: string; customer: string; created: number }[],
};

type FakeSubscription = {
  id: string;
  customer: string;
  status: string;
  metadata: Record<string, string>;
  trial_start: number | null;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  items: {
    data: {
      current_period_start: number;
      current_period_end: number;
      price: { id: string; recurring: { interval: string } };
    }[];
  };
};

let sessionClock = 1_000_000;

/** D-222: the voice agent, as the call routes see it. */
const callDurations = new Map<string, number>();
/** The conversation the last signed URL starts. */
let issuedConversation = '';
const callAgent: CallAgent = {
  signedUrl: () => {
    issuedConversation = `conv_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    return Promise.resolve({
      url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s&conversation_id=${issuedConversation}`,
      conversationId: issuedConversation,
    });
  },
  conversationSeconds: (id) => Promise.resolve(callDurations.get(id) ?? null),
};

const fakeStripe = {
  customers: {
    create: (params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions) => {
      stripeCalls.customers.push({
        params,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
      return Promise.resolve({ id: `cus_${randomUUID().slice(0, 12)}` });
    },
  },
  prices: {
    retrieve: (id: string) => Promise.resolve({ id, currency: 'usd' }),
  },
  subscriptions: {
    retrieve: (id: string) => {
      const found = stripeState.subscriptions.get(id);
      return found === undefined
        ? Promise.reject(new Error(`No such subscription: ${id}`))
        : Promise.resolve(found);
    },
    list: (params: { customer: string }) =>
      Promise.resolve({
        data: [...stripeState.subscriptions.values()].filter(
          (row) => row.customer === params.customer,
        ),
      }),
  },
  checkout: {
    sessions: {
      create: (params: CheckoutParams) => {
        stripeCalls.checkouts.push(params);
        const session = {
          id: `cs_test_${randomUUID().slice(0, 8)}`,
          customer: String(params.customer),
          created: (sessionClock += 1),
        };
        stripeState.openSessions.push(session);
        return Promise.resolve({
          ...session,
          url: `https://checkout.stripe.com/c/pay/${session.id}`,
        });
      },
      list: (params: { customer: string }) =>
        Promise.resolve({
          data: stripeState.openSessions.filter((row) => row.customer === params.customer),
        }),
      expire: (id: string) => {
        stripeCalls.expired.push(id);
        stripeState.openSessions = stripeState.openSessions.filter((row) => row.id !== id);
        return Promise.resolve({ id, status: 'expired' });
      },
    },
  },
  billingPortal: {
    sessions: {
      create: (params: Stripe.BillingPortal.SessionCreateParams) => {
        stripeCalls.portals.push(params);
        return Promise.resolve({ url: 'https://billing.stripe.com/p/session/test_1' });
      },
    },
  },
};

/** A subscription as Stripe would hold it after a checkout. */
function stripeSubscription(input: {
  customer: string;
  userId: string;
  price: string;
  status: string;
  trial?: boolean;
}): FakeSubscription {
  const start = Math.floor(Date.now() / 1000) - 60;
  const end = start + (input.trial === true ? 7 : 30) * 24 * 3600;
  const subscription: FakeSubscription = {
    id: `sub_${randomUUID().slice(0, 12)}`,
    customer: input.customer,
    status: input.status,
    metadata: { userId: input.userId },
    trial_start: input.trial === true ? start : null,
    trial_end: input.trial === true ? end : null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    items: {
      data: [
        {
          current_period_start: start,
          current_period_end: end,
          price: { id: input.price, recurring: { interval: 'month' } },
        },
      ],
    },
  };
  stripeState.subscriptions.set(subscription.id, subscription);
  return subscription;
}

let app: INestApplication;
let prisma: PrismaService;
const provider = new FakeProvider();
const users: SignedInUser[] = [];

async function newUser(label: string): Promise<SignedInUser> {
  const user = await signIn(prisma, { label: `d156_${label}_${RUN_ID}` });
  users.push(user);
  return user;
}

/**
 * A Stripe event, signed as Stripe signs it.
 *
 * Pretty-printed on purpose: Stripe's payloads are, and a body that reached
 * the plugin re-serialised by `JSON.stringify` would be different bytes and
 * fail the signature. That is the raw-body path this suite exists to cover.
 *
 * `payload` is what the event SAYS; the sync ignores it and re-reads the
 * subscription from Stripe, which is what lets a case send a stale one.
 */
function signedEvent(
  type: string,
  object: Record<string, unknown>,
  secret: string = ENV.STRIPE_WEBHOOK_SECRET,
): { payload: string; signature: string } {
  const event = {
    id: `evt_${randomUUID().slice(0, 12)}`,
    object: 'event',
    type,
    data: { object },
  };
  const payload = JSON.stringify(event, null, 2);
  const signature = new Stripe(ENV.STRIPE_SECRET_KEY).webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return { payload, signature };
}

function postEvent(signed: { payload: string; signature: string }) {
  return request(app.getHttpServer())
    .post('/api/v1/auth/stripe/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signed.signature)
    .send(signed.payload);
}

async function customerOf(user: SignedInUser): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
  if (row.stripeCustomerId === null) throw new Error('the user has no Stripe customer yet');
  return row.stripeCustomerId;
}

function checkout(user: SignedInUser, plan: 'starter' | 'pro') {
  return request(app.getHttpServer())
    .post('/api/v1/billing/checkout')
    .set(user.headers)
    .send({ plan });
}

async function billingOf(user: SignedInUser) {
  const response = await request(app.getHttpServer())
    .get('/api/v1/billing')
    .set(user.headers)
    .expect(200);
  return BillingResponseSchema.parse(response.body);
}

/**
 * A TanStack adapter that answers the way OpenRouter's does: lifecycle events
 * around some text, then RUN_FINISHED carrying usage and OpenRouter's cost.
 */
class ScriptedIncluded extends BaseTextAdapter<
  'google/gemini-3.8-flash',
  Record<string, never>,
  readonly ['text'],
  never
> {
  readonly name = 'scripted-included';
  constructor(
    private readonly script: {
      readonly costUsd?: number;
      readonly unknownUsage?: boolean;
      readonly failBefore?: boolean;
      readonly endless?: boolean;
      readonly delayMs?: number;
      readonly chars?: number;
    } = {},
  ) {
    super({}, 'google/gemini-3.8-flash');
  }

  private usage() {
    return this.script.unknownUsage === true
      ? undefined
      : { promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: this.script.costUsd };
  }

  async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<StreamChunk> {
    if (this.script.failBefore === true) throw new Error('upstream refused the call');
    const runId = options.runId ?? 'run';
    const threadId = options.threadId ?? 'thread';
    yield { type: EventType.RUN_STARTED, runId, threadId, timestamp: Date.now() };
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'm',
      role: 'assistant',
      timestamp: Date.now(),
    };
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'm',
      delta: 'x'.repeat(this.script.chars ?? 5),
      timestamp: Date.now(),
    };
    if (this.script.endless === true) await new Promise(() => undefined);
    if (this.script.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, this.script.delayMs));
    yield { type: EventType.TEXT_MESSAGE_END, messageId: 'm', timestamp: Date.now() };
    const usage = this.usage();
    yield {
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason: 'stop',
      ...(usage === undefined ? {} : { usage }),
      timestamp: Date.now(),
    };
  }

  async structuredOutput() {
    if (this.script.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, this.script.delayMs));
    const usage = this.usage();
    return {
      data: { ok: true },
      rawText: '{"ok":true}',
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL === '')(
  'D-156 — plans, checkout and the Stripe webhook (real db, real http)',
  () => {
    beforeAll(async () => {
      const { Test } = await import('@nestjs/testing');
      const { CloudAppModule } = await import('../../src/ee/cloud-app.module.js');
      const { CrewaidWsAdapter } = await import('../../src/ws/crewaid-ws.adapter.js');
      const { NEST_APP_OPTIONS } = await import('../../src/bootstrap.js');

      const moduleRef = await Test.createTestingModule({ imports: [CloudAppModule] })
        .overrideProvider(STRIPE_CLIENT)
        .useValue(fakeStripe)
        .overrideProvider(SANDBOX_PROVIDER)
        .useValue(provider)
        .overrideProvider(CALL_AGENT_FACTORY)
        .useValue(() => callAgent)
        .compile();
      // As `bootstrap.ts` boots it: rawBody preserves Stripe signatures and
      // routeConflictPolicy checks CloudAppModule + BillingModule routes.
      app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
      app.useWebSocketAdapter(new CrewaidWsAdapter(app));
      app.setGlobalPrefix('api/v1', { exclude: ['health'] });
      await app.init();
      prisma = app.get(PrismaService);
    });

    afterAll(async () => {
      for (const user of users) {
        await prisma.subscription.deleteMany({ where: { referenceId: user.userId } });
        // The meter walks every computer holding a slot, so one left RUNNING
        // here would be metered by the next suite's billing run.
        await prisma.sandbox.updateMany({
          where: { userId: user.userId },
          data: { state: 'STOPPED' },
        });
        await signOutAndDelete(prisma, user.userId);
      }
      await app?.close();
    });

    it('reports an account that never subscribed as having no plan, with the trial on offer', async () => {
      const user = await newUser('none');
      expect(await billingOf(user)).toEqual({
        plan: 'none',
        status: null,
        period: null,
        cancelAtPeriodEnd: false,
        trialEligible: true,
        compute: { usedSeconds: 0, limitSeconds: 0 },
        model: { usedUsd: 0, allowanceUsd: 0 },
        // D-223: no plan, no voice on Crewaid's key.
        voice: {
          listen: { usedSeconds: 0, limitSeconds: 0 },
          speak: { usedSeconds: 0, limitSeconds: 0 },
        },
      });
    });

    it('opens the $1 trial on a first Starter checkout, and creates the customer once', async () => {
      const user = await newUser('trial');
      const before = stripeCalls.checkouts.length;

      const response = await checkout(user, 'starter').expect(200);
      expect(BillingRedirectResponseSchema.parse(response.body).url).toContain(
        'checkout.stripe.com',
      );

      const params = stripeCalls.checkouts[before];
      expect(params?.mode).toBe('subscription');
      expect(params?.client_reference_id).toBe(user.userId);
      expect(params?.line_items).toEqual([
        { price: ENV.STRIPE_PRICE_STARTER, quantity: 1 },
        {
          quantity: 1,
          price_data: { currency: 'usd', unit_amount: 100, product_data: { name: '7-day trial' } },
        },
      ]);
      expect(params?.subscription_data).toEqual({
        metadata: { userId: user.userId },
        trial_period_days: 7,
      });

      const customer = await customerOf(user);
      expect(params?.customer).toBe(customer);
      expect(stripeCalls.customers.at(-1)?.idempotencyKey).toBe(`crewaid-customer-${user.userId}`);

      // A second checkout before any webhook reuses the customer rather than
      // making another.
      const customersBefore = stripeCalls.customers.length;
      await checkout(user, 'starter').expect(200);
      expect(stripeCalls.customers.length).toBe(customersBefore);
      expect(stripeCalls.checkouts.at(-1)?.customer).toBe(customer);
    });

    it('leaves only the newest checkout payable: two tabs cannot buy two subscriptions', async () => {
      const user = await newUser('twotabs');
      await checkout(user, 'starter').expect(200);
      const customer = await customerOf(user);
      const first = stripeState.openSessions.find((row) => row.customer === customer);
      await checkout(user, 'pro').expect(200);

      const open = stripeState.openSessions.filter((row) => row.customer === customer);
      expect(open).toHaveLength(1);
      expect(open[0]?.id).not.toBe(first?.id);
      expect(stripeCalls.expired).toContain(first?.id);
    });

    it('charges Pro in full with no trial and no $1', async () => {
      const user = await newUser('pro');
      await checkout(user, 'pro').expect(200);
      const params = stripeCalls.checkouts.at(-1);
      expect(params?.line_items).toEqual([{ price: ENV.STRIPE_PRICE_PRO, quantity: 1 }]);
      expect(params?.subscription_data).toEqual({ metadata: { userId: user.userId } });
    });

    it('turns a signed webhook into the trial, from Stripe’s own copy of the subscription', async () => {
      const user = await newUser('webhook');
      await checkout(user, 'starter').expect(200);
      const customer = await customerOf(user);
      const subscription = stripeSubscription({
        customer,
        userId: user.userId,
        price: ENV.STRIPE_PRICE_STARTER,
        status: 'trialing',
        trial: true,
      });

      await postEvent(signedEvent('customer.subscription.created', { id: subscription.id })).expect(
        200,
      );

      const billing = await billingOf(user);
      expect(billing).toMatchObject({
        plan: 'trial',
        status: 'trialing',
        trialEligible: false,
        compute: { usedSeconds: 0, limitSeconds: 36000 },
        model: { usedUsd: 0, allowanceUsd: 1 },
      });
      const periodEnd = subscription.items.data[0]?.current_period_end ?? 0;
      expect(billing.period?.end).toBe(new Date(periodEnd * 1000).toISOString());

      // A redelivery makes no second row.
      await postEvent(signedEvent('customer.subscription.created', { id: subscription.id })).expect(
        200,
      );
      expect(await prisma.subscription.count({ where: { referenceId: user.userId } })).toBe(1);

      // In force: no second subscription, and the portal is where plans change.
      const refused = await checkout(user, 'pro').expect(409);
      expect(refused.body.code).toBe('BILLING_PLAN_ACTIVE');

      const portal = await request(app.getHttpServer())
        .post('/api/v1/billing/portal')
        .set(user.headers)
        .expect(200);
      expect(BillingRedirectResponseSchema.parse(portal.body).url).toContain('billing.stripe.com');
      expect(stripeCalls.portals.at(-1)?.customer).toBe(customer);
    });

    it('keeps a cancellation that arrived before the creation: events are read, not trusted', async () => {
      const user = await newUser('order');
      await checkout(user, 'starter').expect(200);
      const subscription = stripeSubscription({
        customer: await customerOf(user),
        userId: user.userId,
        price: ENV.STRIPE_PRICE_STARTER,
        status: 'canceled',
        trial: true,
      });

      // Deleted first, then the stale creation saying "trialing".
      await postEvent(
        signedEvent('customer.subscription.deleted', { id: subscription.id, status: 'canceled' }),
      ).expect(200);
      await postEvent(
        signedEvent('customer.subscription.created', { id: subscription.id, status: 'trialing' }),
      ).expect(200);

      expect(await billingOf(user)).toMatchObject({ plan: 'none', status: 'canceled' });
      // And the trial it had still counts as used.
      expect((await billingOf(user)).trialEligible).toBe(false);
    });

    it('answers 400 when the write fails, so Stripe delivers the event again', async () => {
      const user = await newUser('retry');
      // A subscription whose customer no user owns: nothing to attach it to.
      const subscription = stripeSubscription({
        customer: `cus_nobody_${RUN_ID}`,
        userId: user.userId,
        price: ENV.STRIPE_PRICE_STARTER,
        status: 'active',
      });
      await postEvent(signedEvent('customer.subscription.created', { id: subscription.id })).expect(
        400,
      );
      expect(
        await prisma.subscription.count({ where: { stripeSubscriptionId: subscription.id } }),
      ).toBe(0);
    });

    it('refuses a checkout while Stripe has a live subscription the webhook has not delivered', async () => {
      const user = await newUser('lag');
      await checkout(user, 'starter').expect(200);
      stripeSubscription({
        customer: await customerOf(user),
        userId: user.userId,
        price: ENV.STRIPE_PRICE_STARTER,
        status: 'trialing',
        trial: true,
      });
      const refused = await checkout(user, 'pro').expect(409);
      expect(refused.body.code).toBe('BILLING_PLAN_ACTIVE');
    });

    it.each(['past_due', 'unpaid', 'paused', 'incomplete'])(
      'sends a %s subscription to the portal instead of selling a second one',
      async (status) => {
        const user = await newUser(`recover_${status}`);
        await checkout(user, 'starter').expect(200);
        const subscription = stripeSubscription({
          customer: await customerOf(user),
          userId: user.userId,
          price: ENV.STRIPE_PRICE_STARTER,
          status,
        });
        await postEvent(
          signedEvent('customer.subscription.updated', { id: subscription.id }),
        ).expect(200);
        const refused = await checkout(user, 'starter').expect(409);
        expect(refused.body.code).toBe('BILLING_PLAN_ACTIVE');
      },
    );

    it('offers no second trial when Stripe remembers one this server does not', async () => {
      const user = await newUser('trialhistory');
      await checkout(user, 'starter').expect(200);
      const ended = stripeSubscription({
        customer: await customerOf(user),
        userId: user.userId,
        price: ENV.STRIPE_PRICE_STARTER,
        status: 'canceled',
        trial: true,
      });
      expect(ended.status).toBe('canceled');
      await checkout(user, 'starter').expect(200);
      const params = stripeCalls.checkouts.at(-1);
      expect(params?.line_items).toEqual([{ price: ENV.STRIPE_PRICE_STARTER, quantity: 1 }]);
      expect(params?.subscription_data).toEqual({ metadata: { userId: user.userId } });
    });

    it('refuses a webhook whose signature does not match, and records nothing', async () => {
      const user = await newUser('forged');
      await checkout(user, 'pro').expect(200);
      const subscription = stripeSubscription({
        customer: await customerOf(user),
        userId: user.userId,
        price: ENV.STRIPE_PRICE_PRO,
        status: 'active',
      });
      await postEvent(
        signedEvent('customer.subscription.created', { id: subscription.id }, 'whsec_not_ours'),
      ).expect(400);
      expect(await prisma.subscription.count({ where: { referenceId: user.userId } })).toBe(0);
    });

    it('sends an account that never checked out to choose a plan instead of the portal', async () => {
      const user = await newUser('noportal');
      const refused = await request(app.getHttpServer())
        .post('/api/v1/billing/portal')
        .set(user.headers)
        .expect(409);
      expect(refused.body.code).toBe('BILLING_NO_CUSTOMER');
    });

    it('puts an admin on the internal plan with no limits and no Stripe', async () => {
      const user = await newUser('admin');
      await prisma.user.update({ where: { id: user.userId }, data: { role: 'admin' } });
      expect(await billingOf(user)).toMatchObject({
        plan: 'internal',
        status: null,
        compute: { limitSeconds: null },
        model: { allowanceUsd: null },
      });
    });

    it('refuses a checkout for a plan nobody can buy', async () => {
      const user = await newUser('badplan');
      await request(app.getHttpServer())
        .post('/api/v1/billing/checkout')
        .set(user.headers)
        .send({ plan: 'internal' })
        .expect(400);
    });

    it('answers only a signed-in caller', async () => {
      await request(app.getHttpServer()).get('/api/v1/billing').expect(401);
    });

    // ── Calls (D-222) ─────────────────────────────────────────────────────

    it('offers calls on Pro only, and settles a call to ElevenLabs’ count', async () => {
      const server = app.getHttpServer();
      const starter = await newUser('call-starter');
      await subscribe(starter, 'starter', 'active');
      const starterBot = await botFor(starter);
      const refused = await request(server)
        .post(`/api/v1/bots/${starterBot}/calls`)
        .set(starter.headers)
        .expect(402);
      expect(refused.body).toMatchObject({ code: CALL_PLAN_REQUIRED_CODE });

      const pro = await newUser('call-pro');
      await subscribe(pro, 'pro', 'active');
      const proBot = await botFor(pro);
      const started = StartCallResponseSchema.parse(
        (await request(server).post(`/api/v1/bots/${proBot}/calls`).set(pro.headers).expect(201))
          .body,
      );
      expect(started.remainingSeconds).toBe(1800);

      // Someone else's call is not theirs to end: the guard answers 404.
      await request(server)
        .patch(`/api/v1/calls/${started.callId}`)
        .set(starter.headers)
        .send({ ended: true })
        .expect(404);

      const conversationId = issuedConversation;
      callDurations.set(conversationId, 42);
      await request(server)
        .patch(`/api/v1/calls/${started.callId}`)
        .set(pro.headers)
        .send({ conversationId })
        .expect(200);
      const ended = await request(server)
        .patch(`/api/v1/calls/${started.callId}`)
        .set(pro.headers)
        .send({ ended: true })
        .expect(200);
      expect(ended.body.call).toMatchObject({ conversationId, durationSeconds: 42 });
      const allowance = await request(server)
        .get('/api/v1/calls/allowance')
        .set(pro.headers)
        .expect(200);
      expect(allowance.body).toEqual({ limitSeconds: 1800, usedSeconds: 42 });
    });

    // ── Computer time (D-156, part 2) ─────────────────────────────────────

    /** A plan in force, as the webhook would have written it. */
    async function subscribe(
      user: SignedInUser,
      plan: 'starter' | 'pro',
      status: 'trialing' | 'active',
    ): Promise<{ start: Date; end: Date }> {
      const start = new Date(Date.now() - 24 * 3600 * 1000);
      const end = new Date(start.getTime() + 30 * 24 * 3600 * 1000);
      await prisma.subscription.create({
        data: {
          id: randomUUID(),
          plan,
          referenceId: user.userId,
          status,
          periodStart: start,
          periodEnd: end,
          ...(status === 'trialing' && { trialStart: start, trialEnd: end }),
        },
      });
      return { start, end };
    }

    async function botFor(user: SignedInUser): Promise<string> {
      const bot = await privateComputerBot(prisma, provider, user.userId, {
        name: `d156-bot-${randomUUID().slice(0, 8)}`,
        role: 'R',
        avatarColor: '#123456',
        systemPrompt: 'x',
      });
      return bot.id;
    }

    function start(user: SignedInUser, botId: string) {
      return request(app.getHttpServer())
        .post(`/api/v1/bots/${botId}/sandbox/start`)
        .set(user.headers);
    }

    async function computerOf(botId: string) {
      return prisma.sandbox.findFirstOrThrow({ where: { bots: { some: { id: botId } } } });
    }

    async function usedSeconds(user: SignedInUser, periodStart: Date): Promise<number> {
      const row = await prisma.usageLedger.findUnique({
        where: { userId_periodStart: { userId: user.userId, periodStart } },
      });
      return row?.computeSeconds ?? 0;
    }

    it('refuses to start a computer for an account with no plan, before anything else', async () => {
      const user = await newUser('noplan');
      const botId = await botFor(user);
      const refused = await start(user, botId).expect(402);
      expect(refused.body.code).toBe('PLAN_REQUIRED');
      expect((await computerOf(botId)).state).toBe('STOPPED');
    });

    it('starts an admin’s computer with no plan at all', async () => {
      const user = await newUser('admincomputer');
      await prisma.user.update({ where: { id: user.userId }, data: { role: 'admin' } });
      const botId = await botFor(user);
      expect((await start(user, botId).expect(200)).body.state).toBe('RUNNING');
    });

    it('counts running time once per interval, from the last start, never twice', async () => {
      const user = await newUser('meter');
      const period = await subscribe(user, 'starter', 'trialing');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const computer = await computerOf(botId);
      const startedAt = new Date(Date.now() - 90_000);
      await prisma.sandbox.update({
        where: { id: computer.id },
        data: { lastStartedAt: startedAt, meteredAt: null },
      });
      const meter = app.get(SandboxMeterService);

      const now = new Date(startedAt.getTime() + 90_000);
      await meter.sweep(now);
      expect(await usedSeconds(user, period.start)).toBe(90);

      // The same instant again charges nothing: the watermark already moved.
      await meter.sweep(now);
      expect(await usedSeconds(user, period.start)).toBe(90);

      await meter.sweep(new Date(now.getTime() + 60_000));
      expect(await usedSeconds(user, period.start)).toBe(150);

      // A gap no process watched is capped at two intervals.
      await meter.sweep(new Date(now.getTime() + 60_000 + 3_600_000));
      expect(await usedSeconds(user, period.start)).toBe(270);
    });

    it('stops a running computer when the hours run out, and refuses the next start with why', async () => {
      const user = await newUser('limit');
      const period = await subscribe(user, 'starter', 'trialing');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const computer = await computerOf(botId);
      const now = new Date();
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          computeSeconds: 10 * 3600 - 30,
        },
      });
      await prisma.sandbox.update({
        where: { id: computer.id },
        data: {
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: new Date(now.getTime() - 60_000),
        },
      });

      await app.get(SandboxMeterService).sweep(now);
      expect(await usedSeconds(user, period.start)).toBe(10 * 3600 + 30);
      expect((await computerOf(botId)).state).toBe('STOPPED');

      const refused = await start(user, botId).expect(402);
      expect(refused.body.code).toBe('COMPUTE_ALLOWANCE_EXHAUSTED');
      expect(refused.body.detail).toEqual({
        usedSeconds: 10 * 3600 + 30,
        limitSeconds: 10 * 3600,
        resetsAt: period.end.toISOString(),
      });
    });

    it('stops a running computer whose plan has lapsed', async () => {
      const user = await newUser('lapsed');
      await subscribe(user, 'starter', 'active');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      await prisma.subscription.updateMany({
        where: { referenceId: user.userId },
        data: { status: 'past_due' },
      });
      const computer = await computerOf(botId);
      const now = new Date();
      await prisma.sandbox.update({
        where: { id: computer.id },
        data: {
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: new Date(now.getTime() - 60_000),
        },
      });
      await app.get(SandboxMeterService).sweep(now);
      expect((await computerOf(botId)).state).toBe('STOPPED');
    });

    it('counts a Pro computer’s time but never stops it for hours', async () => {
      const user = await newUser('pro-meter');
      const period = await subscribe(user, 'pro', 'active');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      // Far past any plan's hours: Pro has none to run out of.
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          computeSeconds: 1000 * 3600,
        },
      });
      const now = new Date();
      await prisma.sandbox.update({
        where: { id: (await computerOf(botId)).id },
        data: {
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: new Date(now.getTime() - 60_000),
        },
      });
      await app.get(SandboxMeterService).sweep(now);
      expect((await computerOf(botId)).state).toBe('RUNNING');
      const ledger = await prisma.usageLedger.findFirstOrThrow({
        where: { userId: user.userId, periodStart: period.start },
      });
      expect(ledger.computeSeconds).toBeGreaterThan(1000 * 3600);
    });

    it('idle-stops a Pro computer like a Starter one', async () => {
      const pro = await newUser('pro-idle');
      const starter = await newUser('starter-idle');
      await subscribe(pro, 'pro', 'active');
      await subscribe(starter, 'starter', 'active');
      const proBot = await botFor(pro);
      const starterBot = await botFor(starter);
      await start(pro, proBot).expect(200);
      await start(starter, starterBot).expect(200);
      const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
      for (const botId of [proBot, starterBot]) {
        await prisma.sandbox.update({
          where: { id: (await computerOf(botId)).id },
          // The start route holds the computer open for a while (§16); that
          // promise is what idle stop honours first, so it is cleared here.
          data: { lastActiveAt: longAgo, lastStartedAt: longAgo, keepRunningUntil: null },
        });
      }

      const previous = process.env['SANDBOX_IDLE_STOP_MS'];
      process.env['SANDBOX_IDLE_STOP_MS'] = '60000';
      const idle = new SandboxIdleService(
        prisma,
        app.get(SandboxService),
        app.get(SandboxActivityService),
        app.get<ComputePolicy>(COMPUTE_POLICY),
      );
      if (previous === undefined) delete process.env['SANDBOX_IDLE_STOP_MS'];
      else process.env['SANDBOX_IDLE_STOP_MS'] = previous;

      await idle.sweep();
      expect((await computerOf(proBot)).state).toBe('STOPPED');
      expect((await computerOf(starterBot)).state).toBe('STOPPED');
    });

    /** Put a computer at the edge of its trial: 30 s left, last counted a minute ago. */
    async function atTheLimit(user: SignedInUser, botId: string, now: Date) {
      const period = await subscribe(user, 'starter', 'trialing');
      await start(user, botId).expect(200);
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          computeSeconds: 10 * 3600 - 30,
        },
      });
      return period;
    }

    it('stops an unhealthy computer at the limit too: a sick container may still be running', async () => {
      const user = await newUser('unhealthy-limit');
      const botId = await botFor(user);
      const now = new Date();
      await atTheLimit(user, botId, now);
      await prisma.sandbox.update({
        where: { id: (await computerOf(botId)).id },
        data: {
          state: 'UNHEALTHY',
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: new Date(now.getTime() - 60_000),
        },
      });
      await app.get(SandboxMeterService).sweep(now);
      expect((await computerOf(botId)).state).toBe('STOPPED');
    });

    it('charges nothing for a runtime reconciliation found gone', async () => {
      const user = await newUser('gone');
      const period = await subscribe(user, 'starter', 'active');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const now = new Date();
      const watermark = new Date(now.getTime() - 60_000);
      // Reconciliation's verdict: UNHEALTHY, container cleared.
      await prisma.sandbox.update({
        where: { id: (await computerOf(botId)).id },
        data: {
          state: 'UNHEALTHY',
          containerId: null,
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: watermark,
        },
      });
      await app.get(SandboxMeterService).sweep(now);
      expect(await usedSeconds(user, period.start)).toBe(0);
      expect((await computerOf(botId)).meteredAt?.toISOString()).toBe(watermark.toISOString());
    });

    it('never moves the watermark back, so a pass with an earlier clock charges nothing twice', async () => {
      const user = await newUser('monotonic');
      const period = await subscribe(user, 'starter', 'active');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const computer = await computerOf(botId);
      const startedAt = new Date(Date.now() - 120_000);
      await prisma.sandbox.update({
        where: { id: computer.id },
        data: { lastStartedAt: startedAt, meteredAt: null },
      });
      const meter = app.get(SandboxMeterService);
      const later = new Date(startedAt.getTime() + 120_000);
      await meter.sweep(later);
      expect(await usedSeconds(user, period.start)).toBe(120);

      // A pass whose clock reads 30 s earlier.
      await meter.sweep(new Date(later.getTime() - 30_000));
      expect(await usedSeconds(user, period.start)).toBe(120);
      expect((await computerOf(botId)).meteredAt?.toISOString()).toBe(later.toISOString());

      // And the next real pass counts only what is new.
      await meter.sweep(new Date(later.getTime() + 60_000));
      expect(await usedSeconds(user, period.start)).toBe(180);
    });

    it('keeps a computer on when the plan covers it again by the time the stop holds its lease', async () => {
      const user = await newUser('recheck');
      await subscribe(user, 'starter', 'active');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const now = new Date();
      for (const state of ['RUNNING', 'UNHEALTHY'] as const) {
        await prisma.sandbox.update({
          where: { id: (await computerOf(botId)).id },
          data: {
            state,
            lastStartedAt: new Date(now.getTime() - 120_000),
            meteredAt: new Date(now.getTime() - 60_000),
          },
        });
        // The pass decides "stop" — and by the time it holds the lease, the
        // plan covers the computer again (a payment landed in between).
        const real = app.get<ComputePolicy>(COMPUTE_POLICY);
        const raced: ComputePolicy = {
          admit: (id) => real.admit(id),
          idleStops: (id) => real.idleStops(id),
          covers: () => Promise.resolve(true),
          record: () => Promise.resolve({ stop: true }),
        };
        const meter = new SandboxMeterService(prisma, app.get(SandboxService), raced);
        await meter.sweep(now);
        // Left as it was found: a released UNHEALTHY row is not made RUNNING.
        expect((await computerOf(botId)).state).toBe(state);
      }
    });

    // ── The included models (D-157, part 3) ───────────────────────────────

    async function modelsOf(user: SignedInUser) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/models')
        .set(user.headers)
        .expect(200);
      return response.body as {
        models: { id: string; kind: string; upstreamModelId: string; available: boolean }[];
        defaultModelId: string | null;
      };
    }

    /** One included call through the metered adapter, to its end. */
    async function drain(user: SignedInUser, modelId: string, upstream: ScriptedIncluded) {
      const spy = vi
        .spyOn(app.get(IncludedModelsService), 'upstreamText')
        .mockImplementation(() => upstream);
      try {
        const { adapter } = await app.get(ModelResolutionService).resolveText(user.userId, modelId);
        for await (const _chunk of adapter.chatStream({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          // Consumed to the end, as the engine does.
        }
      } finally {
        spy.mockRestore();
      }
    }

    async function modelSpend(user: SignedInUser, periodStart: Date): Promise<number> {
      const row = await prisma.usageLedger.findUnique({
        where: { userId_periodStart: { userId: user.userId, periodStart } },
      });
      return Number(row?.modelMicroUsd ?? 0n);
    }

    it('gives an account the included models and makes the default one of them', async () => {
      const user = await newUser('included');
      // Two lists at once must not make two connections or duplicate models.
      const [first] = await Promise.all([modelsOf(user), modelsOf(user), modelsOf(user)]);
      const included = first.models.filter((model) => model.kind === 'crewaid');
      expect(included.map((model) => model.upstreamModelId).sort()).toEqual(
        [
          'anthropic/claude-haiku-4.5',
          'deepseek/deepseek-v4-pro-0813',
          'google/gemini-3.8-flash',
          'openai/gpt-5-mini',
          'z-ai/glm-5.3-flash',
        ].sort(),
      );
      expect(included.every((model) => model.available)).toBe(true);
      expect(
        await prisma.providerConnection.count({ where: { userId: user.userId, kind: 'CREWAID' } }),
      ).toBe(1);
      expect(
        await prisma.providerModel.count({ where: { connection: { userId: user.userId } } }),
      ).toBe(5);

      const again = await modelsOf(user);
      const gemini = again.models.find((m) => m.upstreamModelId === 'google/gemini-3.8-flash');
      expect(again.defaultModelId).toBe(gemini?.id);
    });

    it('leaves the default alone for an account that already has its own connection', async () => {
      const user = await newUser('owndefault');
      await prisma.providerConnection.create({
        data: { userId: user.userId, kind: 'OPENAI', name: 'Mine', state: 'ACTIVE' },
      });
      await modelsOf(user);
      const settings = await prisma.userSettings.findFirst({ where: { userId: user.userId } });
      expect(settings?.defaultModelId ?? null).toBeNull();
    });

    it('refuses every change to the included connection and its models', async () => {
      const user = await newUser('managed');
      const { models } = await modelsOf(user);
      const model = models.find((m) => m.kind === 'crewaid');
      const connection = await prisma.providerConnection.findFirstOrThrow({
        where: { userId: user.userId, kind: 'CREWAID' },
      });
      const server = app.getHttpServer();
      const base = `/api/v1/providers/connections/${connection.id}`;
      await request(server).patch(base).set(user.headers).send({ name: 'Mine now' }).expect(409);
      await request(server).delete(base).set(user.headers).expect(409);
      await request(server)
        .put(`${base}/credential`)
        .set(user.headers)
        .send({ apiKey: 'sk-0123456789abcdef' })
        .expect(409);
      await request(server).delete(`${base}/credential`).set(user.headers).expect(409);
      await request(server)
        .post(`${base}/models`)
        .set(user.headers)
        .send({
          upstreamModelId: 'some/model',
          label: 'Extra',
          contextWindow: 1000,
          capabilities: { tools: true, vision: false, reasoning: false },
        })
        .expect(409);
      await request(server)
        .patch(`/api/v1/providers/models/${model?.id}`)
        .set(user.headers)
        .send({ label: 'Renamed' })
        .expect(409);
      await request(server)
        .delete(`/api/v1/providers/models/${model?.id}`)
        .set(user.headers)
        .expect(409);
      // Nor can anyone make one of their own.
      await request(server)
        .post('/api/v1/providers/connections')
        .set(user.headers)
        .send({ kind: 'crewaid', name: 'Mine' })
        .expect(400);
      expect(
        (await prisma.providerConnection.findUniqueOrThrow({ where: { id: connection.id } })).name,
      ).toBe('Crewaid');
    });

    it('charges every call to the allowance, and itemises it', async () => {
      const user = await newUser('charge');
      const period = await subscribe(user, 'starter', 'active');
      const { models } = await modelsOf(user);
      const gemini = models.find((m) => m.upstreamModelId === 'google/gemini-3.8-flash');
      await drain(user, gemini?.id ?? '', new ScriptedIncluded({ costUsd: 0.002 }));
      expect(await modelSpend(user, period.start)).toBe(2000);
      await drain(user, gemini?.id ?? '', new ScriptedIncluded({ costUsd: 0.002 }));
      expect(await modelSpend(user, period.start)).toBe(4000);

      const charges = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
      expect(charges.every((row) => row.settledAt !== null)).toBe(true);
      expect(charges.map((row) => [row.upstreamModelId, Number(row.costMicroUsd)])).toEqual([
        ['google/gemini-3.8-flash', 2000],
        ['google/gemini-3.8-flash', 2000],
      ]);
      expect((await billingOf(user)).model).toEqual({ usedUsd: 0.004, allowanceUsd: 5 });
    });

    it('refuses an included model once the allowance is spent, and without a plan', async () => {
      const spent = await newUser('spent');
      const period = await subscribe(spent, 'starter', 'active');
      const { models } = await modelsOf(spent);
      const modelId = models.find((m) => m.kind === 'crewaid')?.id ?? '';
      await prisma.usageLedger.create({
        data: {
          userId: spent.userId,
          periodStart: period.start,
          periodEnd: period.end,
          modelMicroUsd: 5_000_000n,
        },
      });
      const resolution = app.get(ModelResolutionService);
      await expect(resolution.resolveText(spent.userId, modelId)).rejects.toBeInstanceOf(
        ModelAllowanceExhaustedError,
      );

      const unpaid = await newUser('unpaid-model');
      const theirs = (await modelsOf(unpaid)).models.find((m) => m.kind === 'crewaid')?.id ?? '';
      await expect(resolution.resolveText(unpaid.userId, theirs)).rejects.toBeInstanceOf(
        ModelAllowanceExhaustedError,
      );
    });

    it('refuses the next call, not the one that crossed the line', async () => {
      const user = await newUser('crossing');
      const period = await subscribe(user, 'starter', 'active');
      const modelId = (await modelsOf(user)).models.find((m) => m.kind === 'crewaid')?.id ?? '';
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          modelMicroUsd: 4_999_000n,
        },
      });
      await drain(user, modelId, new ScriptedIncluded({ costUsd: 0.01 }));
      expect(await modelSpend(user, period.start)).toBe(5_009_000);
      await expect(drain(user, modelId, new ScriptedIncluded({ costUsd: 0.01 }))).rejects.toThrow();
    });

    it('tells the account’s windows when included model use crosses 80%', async () => {
      const user = await newUser('notice-model');
      const period = await subscribe(user, 'starter', 'active');
      const modelId = (await modelsOf(user)).models.find((m) => m.kind === 'crewaid')?.id ?? '';
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          modelMicroUsd: 3_990_000n,
        },
      });
      const notices = vi.spyOn(app.get(TurnEventBus), 'emitUsageNotice');
      try {
        await drain(user, modelId, new ScriptedIncluded({ costUsd: 0.02 }));
        expect(notices).toHaveBeenCalledWith(user.userId, {
          kind: 'model',
          level: 80,
          resetsAt: period.end.toISOString(),
        });
      } finally {
        notices.mockRestore();
      }
    });

    it('tells the account’s windows when computer time crosses 80%', async () => {
      const user = await newUser('notice-compute');
      const period = await subscribe(user, 'starter', 'trialing');
      const botId = await botFor(user);
      await start(user, botId).expect(200);
      const now = new Date();
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          computeSeconds: 8 * 3600 - 30,
        },
      });
      await prisma.sandbox.update({
        where: { id: (await computerOf(botId)).id },
        data: {
          lastStartedAt: new Date(now.getTime() - 120_000),
          meteredAt: new Date(now.getTime() - 60_000),
        },
      });
      const notices = vi.spyOn(app.get(TurnEventBus), 'emitUsageNotice');
      try {
        await app.get(SandboxMeterService).sweep(now);
        expect(notices).toHaveBeenCalledWith(user.userId, {
          kind: 'compute',
          level: 80,
          resetsAt: period.end.toISOString(),
        });
        expect((await computerOf(botId)).state).toBe('RUNNING');
      } finally {
        notices.mockRestore();
      }
    });

    /** An account with `spentMicroUsd` of its $5 Starter allowance already used. */
    async function nearlySpent(label: string, spentMicroUsd: bigint) {
      const user = await newUser(label);
      const period = await subscribe(user, 'starter', 'active');
      const modelId = (await modelsOf(user)).models.find((m) => m.kind === 'crewaid')?.id ?? '';
      await prisma.usageLedger.create({
        data: {
          userId: user.userId,
          periodStart: period.start,
          periodEnd: period.end,
          modelMicroUsd: spentMicroUsd,
        },
      });
      return { user, period, modelId };
    }

    it('keeps the reservation counted when the charge cannot be settled', async () => {
      const { user, period, modelId } = await nearlySpent('unsettled', 0n);
      const billing = app.get(BillingService);
      const failing = vi
        .spyOn(billing, 'settleModelCharge')
        .mockRejectedValue(new Error('database unavailable'));
      try {
        await drain(user, modelId, new ScriptedIncluded({ costUsd: 0.002 }));
        const [charge] = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
        expect(charge?.settledAt).toBeNull();
        // Charged the reservation — an estimate, never nothing.
        expect(Number(charge?.costMicroUsd)).toBeGreaterThan(0);
        expect(await modelSpend(user, period.start)).toBe(Number(charge?.costMicroUsd));
      } finally {
        failing.mockRestore();
      }
    });

    describe('the TanStack meter (MOD-AI-11)', () => {
      async function adapterFor(user: SignedInUser, modelId: string, upstream: ScriptedIncluded) {
        const spy = vi
          .spyOn(app.get(IncludedModelsService), 'upstreamText')
          .mockImplementation(() => upstream);
        const resolved = await app.get(ModelResolutionService).resolveText(user.userId, modelId);
        return { adapter: resolved.adapter, restore: () => spy.mockRestore() };
      }
      const messages = [{ role: 'user' as const, content: 'hi' }];

      it('charges a stream before its RUN_FINISHED reaches the engine, and structured output too', async () => {
        const { user, period, modelId } = await nearlySpent('tanstackcharge', 0n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ costUsd: 0.002 }),
        );
        try {
          let atFinish = -1;
          for await (const chunk of adapter.chatStream({ model: 'm', messages })) {
            if (chunk.type === EventType.RUN_FINISHED)
              atFinish = await modelSpend(user, period.start);
          }
          expect(atFinish).toBe(2000);
          await adapter.structuredOutput({
            chatOptions: { model: 'm', messages },
            outputSchema: { type: 'object' },
          });
          expect(await modelSpend(user, period.start)).toBe(4000);
          const charges = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
          expect(charges.every((charge) => charge.settledAt !== null)).toBe(true);
        } finally {
          restore();
        }
      });

      it('keeps the whole reservation when usage never comes back, never zero', async () => {
        const { user, period, modelId } = await nearlySpent('tanstackunknown', 0n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ unknownUsage: true }),
        );
        try {
          for await (const _chunk of adapter.chatStream({ model: 'm', messages })) void _chunk;
          const [charge] = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
          expect(charge?.settledAt).not.toBeNull();
          expect(Number(charge?.costMicroUsd)).toBeGreaterThan(0);
          expect(await modelSpend(user, period.start)).toBe(Number(charge?.costMicroUsd));
        } finally {
          restore();
        }
      });

      it('charges nothing for a call refused before it produced anything', async () => {
        const { user, period, modelId } = await nearlySpent('tanstackrefused', 0n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ failBefore: true }),
        );
        try {
          await expect(
            (async () => {
              for await (const _chunk of adapter.chatStream({ model: 'm', messages })) void _chunk;
            })(),
          ).rejects.toThrow('upstream refused');
          const [charge] = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
          expect(charge?.settledAt).not.toBeNull();
          expect(Number(charge?.costMicroUsd)).toBe(0);
          expect(await modelSpend(user, period.start)).toBe(0);
        } finally {
          restore();
        }
      });

      it('charges a stream the engine stopped early for what it streamed', async () => {
        const { user, period, modelId } = await nearlySpent('tanstackcancel', 0n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ endless: true, chars: 4000 }),
        );
        try {
          for await (const chunk of adapter.chatStream({ model: 'm', messages })) {
            // The person stops the reply after the first words.
            if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
          }
          const [charge] = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
          expect(charge?.settledAt).not.toBeNull();
          // 1000 streamed tokens at $3.75/M is $0.00375, plus the prompt.
          expect(Number(charge?.costMicroUsd)).toBeGreaterThanOrEqual(3750);
          expect(await modelSpend(user, period.start)).toBe(Number(charge?.costMicroUsd));
        } finally {
          restore();
        }
      });

      it('refuses at resolution when spent, and admits one of several concurrent calls on the last of it', async () => {
        const spent = await nearlySpent('tanstackspent', 5_000_000n);
        await expect(
          app.get(ModelResolutionService).resolveText(spent.user.userId, spent.modelId),
        ).rejects.toBeInstanceOf(ModelAllowanceExhaustedError);

        const { user, modelId } = await nearlySpent('tanstackconcurrent', 4_999_000n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ costUsd: 0.002, delayMs: 50 }),
        );
        try {
          const outcomes = await Promise.allSettled(
            Array.from({ length: 5 }, () =>
              adapter.structuredOutput({
                chatOptions: { model: 'm', messages },
                outputSchema: { type: 'object' },
              }),
            ),
          );
          expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
          expect(
            outcomes.filter(
              (o) => o.status === 'rejected' && o.reason instanceof ModelAllowanceExhaustedError,
            ),
          ).toHaveLength(4);
          expect(await prisma.modelCharge.count({ where: { userId: user.userId } })).toBe(1);
        } finally {
          restore();
        }
      });

      it('a response lost after settlement is not charged again', async () => {
        const { user, period, modelId } = await nearlySpent('tanstacklost', 0n);
        const { adapter, restore } = await adapterFor(
          user,
          modelId,
          new ScriptedIncluded({ costUsd: 0.002 }),
        );
        try {
          for await (const chunk of adapter.chatStream({ model: 'm', messages })) {
            // The consumer dies the moment the finish arrives.
            if (chunk.type === EventType.RUN_FINISHED) break;
          }
          const charges = await prisma.modelCharge.findMany({ where: { userId: user.userId } });
          expect(charges).toHaveLength(1);
          expect(Number(charges[0]?.costMicroUsd)).toBe(2000);
          expect(await modelSpend(user, period.start)).toBe(2000);
        } finally {
          restore();
        }
      });

      /**
       * @skip-reason: @slow on demand — spends real tokens; needs an
       * OpenRouter key. One included call through the real adapter: the
       * ledger moves by exactly OpenRouter's reported cost.
       *
       *   MODAI11_LIVE_OPENROUTER_KEY=sk-or-… pnpm --filter @crewaid/orchestrator \
       *     exec vitest run test/billing.integration.test.ts -t live
       */
      it.skipIf(process.env['MODAI11_LIVE_OPENROUTER_KEY'] === undefined)(
        'live: an included call reconciles the ledger with OpenRouter’s own cost',
        async () => {
          const { user, period, modelId } = await nearlySpent('tanstacklive', 0n);
          const resolved = await app.get(ModelResolutionService).resolveText(user.userId, modelId);
          let reported: number | undefined;
          for await (const chunk of resolved.adapter.chatStream({
            model: resolved.upstreamModelId,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          })) {
            if (
              chunk.type === EventType.RUN_FINISHED &&
              chunk.usage !== undefined &&
              !Array.isArray(chunk.usage)
            )
              reported = chunk.usage.cost;
          }
          expect(reported).toBeGreaterThan(0);
          expect(await modelSpend(user, period.start)).toBe(Math.ceil((reported ?? 0) * 1_000_000));
        },
        60_000,
      );
    });
  },
);
