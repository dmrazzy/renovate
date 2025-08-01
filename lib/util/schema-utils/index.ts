import JSON5 from 'json5';
import { DateTime } from 'luxon';
import type { JsonArray, JsonValue } from 'type-fest';
import {
  type ZodEffects,
  type ZodString,
  type ZodType,
  type ZodTypeDef,
  z,
} from 'zod';
import { logger } from '../../logger';
import type { PackageDependency } from '../../modules/manager/types';
import { parseJsonc } from '../common';
import { parse as parseToml } from '../toml';
import type { YamlOptions } from '../yaml';
import { parseSingleYaml, parseYaml } from '../yaml';

interface ErrorContext<T> {
  error: z.ZodError;
  input: T;
}

interface LooseOpts<T> {
  onError?: (err: ErrorContext<T>) => void;
}

/**
 * Works like `z.array()`, but drops wrong elements instead of invalidating the whole array.
 *
 * **Important**: non-array inputs are still invalid.
 * Use `LooseArray(...).catch([])` to handle it.
 *
 * @param Elem Schema for array elements
 * @param onError Callback for errors
 * @returns Schema for array
 */
export function LooseArray<Schema extends z.ZodTypeAny>(
  Elem: Schema,
  { onError }: LooseOpts<unknown[]> = {},
): z.ZodEffects<z.ZodArray<z.ZodAny, 'many'>, z.TypeOf<Schema>[], any[]> {
  if (!onError) {
    // Avoid error-related computations inside the loop
    return z.array(z.any()).transform((input) => {
      const output: z.infer<Schema>[] = [];
      for (const x of input) {
        const parsed = Elem.safeParse(x);
        if (parsed.success) {
          output.push(parsed.data);
        }
      }
      return output;
    });
  }

  return z.array(z.any()).transform((input) => {
    const output: z.infer<Schema>[] = [];
    const issues: z.ZodIssue[] = [];

    for (let idx = 0; idx < input.length; idx += 1) {
      const x = input[idx];
      const parsed = Elem.safeParse(x);

      if (parsed.success) {
        output.push(parsed.data);
        continue;
      }

      for (const issue of parsed.error.issues) {
        issue.path.unshift(idx);
        issues.push(issue);
      }
    }

    if (issues.length) {
      const error = new z.ZodError(issues);
      onError({ error, input });
    }

    return output;
  });
}

type LooseRecordResult<
  KeySchema extends z.ZodTypeAny,
  ValueSchema extends z.ZodTypeAny,
> = z.ZodEffects<
  z.ZodRecord<z.ZodString, z.ZodAny>,
  Record<z.TypeOf<KeySchema>, z.TypeOf<ValueSchema>>,
  Record<z.TypeOf<KeySchema>, any>
>;

type LooseRecordOpts<
  KeySchema extends z.ZodTypeAny,
  ValueSchema extends z.ZodTypeAny,
> = LooseOpts<Record<z.TypeOf<KeySchema> | z.TypeOf<ValueSchema>, unknown>>;

/**
 * Works like `z.record()`, but drops wrong elements instead of invalidating the whole record.
 *
 * **Important**: non-record inputs other are still invalid.
 * Use `LooseRecord(...).catch({})` to handle it.
 *
 * @param KeyValue Schema for record keys
 * @param ValueValue Schema for record values
 * @param onError Callback for errors
 * @returns Schema for record
 */
export function LooseRecord<ValueSchema extends z.ZodTypeAny>(
  Value: ValueSchema,
): LooseRecordResult<z.ZodString, ValueSchema>;
export function LooseRecord<
  KeySchema extends z.ZodTypeAny,
  ValueSchema extends z.ZodTypeAny,
>(
  Key: KeySchema,
  Value: ValueSchema,
): LooseRecordResult<KeySchema, ValueSchema>;
export function LooseRecord<ValueSchema extends z.ZodTypeAny>(
  Value: ValueSchema,
  { onError }: LooseRecordOpts<z.ZodString, ValueSchema>,
): LooseRecordResult<z.ZodString, ValueSchema>;
export function LooseRecord<
  KeySchema extends z.ZodTypeAny,
  ValueSchema extends z.ZodTypeAny,
>(
  Key: KeySchema,
  Value: ValueSchema,
  { onError }: LooseRecordOpts<KeySchema, ValueSchema>,
): LooseRecordResult<KeySchema, ValueSchema>;
export function LooseRecord<
  KeySchema extends z.ZodTypeAny,
  ValueSchema extends z.ZodTypeAny,
>(
  arg1: ValueSchema | KeySchema,
  arg2?: ValueSchema | LooseOpts<Record<string, unknown>>,
  arg3?: LooseRecordOpts<KeySchema, ValueSchema>,
): LooseRecordResult<KeySchema, ValueSchema> {
  let Key: z.ZodSchema = z.any();
  let Value: ValueSchema;
  let opts: LooseRecordOpts<KeySchema, ValueSchema> = {};
  if (arg2 && arg3) {
    Key = arg1 as KeySchema;
    Value = arg2 as ValueSchema;
    opts = arg3;
  } else if (arg2) {
    if (arg2 instanceof z.ZodType) {
      Key = arg1 as KeySchema;
      Value = arg2;
    } else {
      Value = arg1 as ValueSchema;
      opts = arg2;
    }
  } else {
    Value = arg1 as ValueSchema;
  }

  const { onError } = opts;
  if (!onError) {
    // Avoid error-related computations inside the loop
    return z.record(z.any()).transform((input) => {
      const output: Record<string, z.infer<ValueSchema>> = {};
      for (const [inputKey, inputVal] of Object.entries(input)) {
        const parsedKey = Key.safeParse(inputKey);
        const parsedValue = Value.safeParse(inputVal);
        if (parsedKey.success && parsedValue.success) {
          output[parsedKey.data] = parsedValue.data;
        }
      }
      return output;
    });
  }

  return z.record(z.any()).transform((input) => {
    const output: Record<string, z.infer<ValueSchema>> = {};
    const issues: z.ZodIssue[] = [];

    for (const [inputKey, inputVal] of Object.entries(input)) {
      const parsedKey = Key.safeParse(inputKey);
      if (!parsedKey.success) {
        for (const issue of parsedKey.error.issues) {
          issue.path.unshift(inputKey);
          issues.push(issue);
        }
        continue;
      }

      const parsedValue = Value.safeParse(inputVal);
      if (!parsedValue.success) {
        for (const issue of parsedValue.error.issues) {
          issue.path.unshift(inputKey);
          issues.push(issue);
        }
        continue;
      }

      output[parsedKey.data] = parsedValue.data;
      continue;
    }

    if (issues.length) {
      const error = new z.ZodError(issues);
      onError({ error, input });
    }

    return output;
  });
}

export const Json = z.string().transform((str, ctx): JsonValue => {
  try {
    return JSON.parse(str);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSON' });
    return z.NEVER;
  }
});
type Json = z.infer<typeof Json>;

export const Json5 = z.string().transform((str, ctx): JsonValue => {
  try {
    return JSON5.parse(str);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSON5' });
    return z.NEVER;
  }
});

export const Jsonc = z.string().transform((str, ctx): JsonValue => {
  try {
    return parseJsonc(str);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSONC' });
    return z.NEVER;
  }
});

export const UtcDate = z
  .string({ description: 'ISO 8601 string' })
  .transform((str, ctx): DateTime => {
    const date = DateTime.fromISO(str, { zone: 'utc' });
    if (!date.isValid) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return date;
  });

export const Yaml = z.string().transform((str, ctx): JsonValue => {
  try {
    return parseSingleYaml(str);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid YAML' });
    return z.NEVER;
  }
});

export const MultidocYaml = z.string().transform((str, ctx): JsonArray => {
  try {
    return parseYaml(str) as JsonArray;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid YAML' });
    return z.NEVER;
  }
});

export function multidocYaml(
  opts?: Omit<YamlOptions, 'customSchema'>,
): ZodEffects<ZodString, JsonArray, string> {
  return z.string().transform((str, ctx): JsonArray => {
    try {
      return parseYaml(str, opts) as JsonArray;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid YAML' });
      return z.NEVER;
    }
  });
}

export const Toml = z.string().transform((str, ctx) => {
  try {
    return parseToml(str);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid TOML' });
    return z.NEVER;
  }
});

export function withDepType<
  Output extends PackageDependency[],
  Schema extends ZodType<Output, ZodTypeDef, unknown>,
>(schema: Schema, depType: string, force = true): ZodEffects<Schema> {
  return schema.transform((deps) => {
    for (const dep of deps) {
      if (!dep.depType || force) {
        dep.depType = depType;
      }
    }
    return deps;
  });
}

export function withDebugMessage<Input, Output>(
  value: Output,
  msg: string,
): (ctx: { error: z.ZodError; input: Input }) => Output {
  return ({ error: err }) => {
    logger.debug({ err }, msg);
    return value;
  };
}

export function withTraceMessage<Input, Output>(
  value: Output,
  msg: string,
): (ctx: { error: z.ZodError; input: Input }) => Output {
  return ({ error: err }) => {
    logger.trace({ err }, msg);
    return value;
  };
}

function isCircular(value: unknown, visited = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  if (visited.has(value)) {
    return true;
  }

  const downstreamVisited = new Set(visited);
  downstreamVisited.add(value);

  if (Array.isArray(value)) {
    for (const childValue of value) {
      if (isCircular(childValue, downstreamVisited)) {
        return true;
      }
    }

    return false;
  }

  const values = Object.values(value);
  for (const ov of values) {
    if (isCircular(ov, downstreamVisited)) {
      return true;
    }
  }

  return false;
}

export const NotCircular = z.unknown().superRefine((val, ctx) => {
  if (isCircular(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'values cannot be circular data structures',
      fatal: true,
    });

    return z.NEVER;
  }
});
