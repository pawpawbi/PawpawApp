// Ordering and safety checks for transformed tables, which are built from other tables.
// A DependencyMap gives, for each transformed table, the tables its query reads. Names that
// aren't keys (loaded tables) are treated as already up to date.

export type DependencyMap = Record<string, string[]>;

/**
 * Transformed tables in an order where each comes after the transformed tables it reads.
 * Tables in (or downstream of) a circular reference can't be ordered and are listed in `blocked`.
 */
export function buildOrder(deps: DependencyMap): {
  order: string[];
  blocked: string[];
} {
  const tables = Object.keys(deps).sort();
  const waitingOn = new Map(
    tables.map((t) => [
      t,
      new Set(deps[t].filter((d) => d in deps && d !== t)),
    ]),
  );
  for (const t of tables) if (deps[t].includes(t)) waitingOn.get(t)!.add(t); // reads itself

  const order: string[] = [];
  let ready = tables.filter((t) => waitingOn.get(t)!.size === 0);
  while (ready.length) {
    const next: string[] = [];
    for (const t of ready) {
      order.push(t);
      waitingOn.delete(t);
      for (const [other, waiting] of waitingOn) {
        if (waiting.delete(t) && waiting.size === 0) next.push(other);
      }
    }
    ready = next.sort();
  }
  return { order, blocked: [...waitingOn.keys()] };
}

/**
 * A circular reference that `table` would be part of, as a path such as ["a", "b", "a"], or
 * null if there's none.
 */
export function findCycle(deps: DependencyMap, table: string): string[] | null {
  const visit = (current: string, path: string[]): string[] | null => {
    for (const dep of deps[current] ?? []) {
      if (dep === table) return [...path, dep];
      if (!(dep in deps) || path.includes(dep)) continue;
      const found = visit(dep, [...path, dep]);
      if (found) return found;
    }
    return null;
  };
  return visit(table, [table]);
}

/** Transformed tables that read `table` directly. */
export function directDependents(deps: DependencyMap, table: string): string[] {
  return Object.keys(deps)
    .filter((t) => t !== table && deps[t].includes(table))
    .sort();
}

/** Transformed tables that read any of `changed`, directly or indirectly, in build order. */
export function downstreamOf(deps: DependencyMap, changed: string[]): string[] {
  const affected = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const current = queue.shift()!;
    for (const dependent of directDependents(deps, current)) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return buildOrder(deps).order.filter((t) => affected.has(t));
}
