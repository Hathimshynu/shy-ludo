import type { Redis } from 'ioredis';

/**
 * Matchmaking queue. `popIfAtLeast` must be atomic: it either removes exactly `n`
 * users or nothing, so two matchers can never build overlapping matches.
 */
export interface MatchQueue {
  add(size: number, userId: string): Promise<void>;
  remove(size: number, userId: string): Promise<void>;
  length(size: number): Promise<number>;
  popIfAtLeast(size: number, n: number): Promise<string[] | null>;
}

/** Room-code uniqueness registry. */
export interface CodeRegistry {
  claim(code: string, roomId: string): Promise<boolean>;
  release(code: string): Promise<void>;
}

export class MemoryMatchQueue implements MatchQueue {
  private readonly queues = new Map<number, string[]>();

  private q(size: number): string[] {
    let q = this.queues.get(size);
    if (!q) {
      q = [];
      this.queues.set(size, q);
    }
    return q;
  }

  async add(size: number, userId: string): Promise<void> {
    const q = this.q(size);
    if (!q.includes(userId)) q.push(userId);
  }

  async remove(size: number, userId: string): Promise<void> {
    const q = this.q(size);
    const i = q.indexOf(userId);
    if (i >= 0) q.splice(i, 1);
  }

  async length(size: number): Promise<number> {
    return this.q(size).length;
  }

  async popIfAtLeast(size: number, n: number): Promise<string[] | null> {
    const q = this.q(size);
    if (q.length < n) return null;
    return q.splice(0, n);
  }
}

export class MemoryCodeRegistry implements CodeRegistry {
  private readonly codes = new Map<string, string>();

  async claim(code: string, roomId: string): Promise<boolean> {
    if (this.codes.has(code)) return false;
    this.codes.set(code, roomId);
    return true;
  }

  async release(code: string): Promise<void> {
    this.codes.delete(code);
  }
}

const POP_SCRIPT = `
local len = redis.call('LLEN', KEYS[1])
local n = tonumber(ARGV[1])
if len < n then return nil end
local items = redis.call('LRANGE', KEYS[1], 0, n - 1)
redis.call('LTRIM', KEYS[1], n, -1)
return items
`;

const ADD_SCRIPT = `
redis.call('LREM', KEYS[1], 0, ARGV[1])
return redis.call('RPUSH', KEYS[1], ARGV[1])
`;

export class RedisMatchQueue implements MatchQueue {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'ludo:mm:',
  ) {}

  private key(size: number): string {
    return `${this.prefix}${size}`;
  }

  async add(size: number, userId: string): Promise<void> {
    await this.redis.eval(ADD_SCRIPT, 1, this.key(size), userId);
  }

  async remove(size: number, userId: string): Promise<void> {
    await this.redis.lrem(this.key(size), 0, userId);
  }

  async length(size: number): Promise<number> {
    return this.redis.llen(this.key(size));
  }

  async popIfAtLeast(size: number, n: number): Promise<string[] | null> {
    const result = (await this.redis.eval(POP_SCRIPT, 1, this.key(size), String(n))) as string[] | null;
    return result && result.length === n ? result : null;
  }
}

export class RedisCodeRegistry implements CodeRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'ludo:room-code:',
    private readonly ttlSeconds = 60 * 60 * 24,
  ) {}

  async claim(code: string, roomId: string): Promise<boolean> {
    const ok = await this.redis.set(`${this.prefix}${code}`, roomId, 'EX', this.ttlSeconds, 'NX');
    return ok === 'OK';
  }

  async release(code: string): Promise<void> {
    await this.redis.del(`${this.prefix}${code}`);
  }
}
