import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  OWNED_RESOURCE,
  type OwnedResourceSpec,
} from '../src/ownership/owned-resource.decorator.js';

/**
 * D-010's fence, shared by the core suite (`ownership-route-coverage.test.ts`)
 * and the Enterprise one (`ee/ownership-route-coverage-ee.test.ts`, D-238), so
 * both judge routes by the same rules and neither names the other's modules.
 *
 * Route metadata is plain reflection on the decorators, so this walks the
 * module graph without instantiating anything.
 */

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

export interface DiscoveredRoute {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly spec: OwnedResourceSpec | undefined;
}

export interface Exemption {
  readonly route: string;
  readonly reason: string;
}

/** Every route parameter in a path, e.g. `bots/:id/messages` -> ['id']. */
export function parametersOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => name ?? '');
}

function joinPath(base: unknown, sub: unknown): string {
  const segments = [base, sub]
    .map((part) => (typeof part === 'string' ? part : ''))
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '');
  return segments.join('/');
}

/** A dynamic module's own `controllers` or `imports`, which carry no metadata. */
function dynamicField(current: unknown, field: 'controllers' | 'imports'): unknown[] {
  if (typeof current !== 'object' || current === null || !(field in current)) return [];
  const value = (current as Record<string, unknown>)[field];
  return Array.isArray(value) ? value : [];
}

/**
 * Follows `imports` from the root module, including dynamic-module wrappers,
 * whose `controllers` and `imports` are plain fields rather than metadata.
 */
export function collectControllers(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const controllers: unknown[] = [];
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    const module =
      typeof current === 'object' && current !== null && 'module' in current
        ? (current as { module: unknown }).module
        : current;
    if (module === undefined || module === null || seen.has(module)) continue;
    seen.add(module);

    const own = Reflect.getMetadata('controllers', module as object);
    if (Array.isArray(own)) controllers.push(...own);
    controllers.push(...dynamicField(current, 'controllers'));

    const imports = Reflect.getMetadata('imports', module as object);
    if (Array.isArray(imports)) queue.push(...imports);
    queue.push(...dynamicField(current, 'imports'));
  }

  return controllers;
}

/** The routes `controllers` declare, sorted by method and path. */
export function routesOf(controllers: readonly unknown[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const controller of controllers) {
    if (typeof controller !== 'function') continue;
    const basePath: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const classSpec = Reflect.getMetadata(OWNED_RESOURCE, controller) as
      OwnedResourceSpec | undefined;
    const prototype: object = controller.prototype as object;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const handler = descriptor?.value as unknown;
      if (typeof handler !== 'function') continue;

      const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof verb !== 'number') continue;

      const handlerSpec = Reflect.getMetadata(OWNED_RESOURCE, handler) as
        OwnedResourceSpec | undefined;

      routes.push({
        controller: controller.name,
        handler: name,
        method: RequestMethod[verb] ?? String(verb),
        path: joinPath(basePath, Reflect.getMetadata(PATH_METADATA, handler)),
        spec: handlerSpec ?? classSpec,
      });
    }
  }

  return routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

export const routeKey = (route: Pick<DiscoveredRoute, 'method' | 'path'>): string =>
  `${route.method} /${route.path}`;

/** Parameterised routes with neither a marker nor an exemption. */
export function unfenced(
  routes: readonly DiscoveredRoute[],
  exemptions: readonly Exemption[],
): string[] {
  const exempt = new Set(exemptions.map((entry) => entry.route));
  return routes
    .filter((route) => parametersOf(route.path).length > 0)
    .filter((route) => route.spec === undefined)
    .filter((route) => !exempt.has(routeKey(route)))
    .map((route) => `${routeKey(route)} (${route.controller}.${route.handler})`);
}

/** Markers naming a parameter their route does not declare. */
export function mismatched(routes: readonly DiscoveredRoute[]): string[] {
  return routes
    .filter((route) => route.spec !== undefined)
    .filter((route) => !parametersOf(route.path).includes(route.spec?.param ?? ''))
    .map((route) => `${routeKey(route)} marks :${route.spec?.param ?? ''}`);
}

/** Markers on routes that carry no parameter at all. */
export function pointless(routes: readonly DiscoveredRoute[]): string[] {
  return routes
    .filter((route) => route.spec !== undefined && parametersOf(route.path).length === 0)
    .map(routeKey);
}
