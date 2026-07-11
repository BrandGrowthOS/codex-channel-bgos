import { z } from "zod";

import type { PluginConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";

const envSchema = z.object({
  BGOS_BASE_URL: z.string().url().optional(),
  BGOS_PAIRING_TOKEN: z.string().min(20),
});

export function loadConfigFromEnv(): PluginConfig {
  const env = envSchema.parse(process.env);
  return {
    baseUrl: (env.BGOS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    pairingToken: env.BGOS_PAIRING_TOKEN,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
  };
}

const cfgSchema = z.object({
  baseUrl: z.string().url().optional(),
  pairingToken: z.string().min(20),
  reconnect: z
    .object({
      initialDelayMs: z.number().int().positive().optional(),
      maxDelayMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export function loadConfigFromPluginCfg(cfg: unknown): PluginConfig {
  const parsed = cfgSchema.parse(cfg);
  return {
    baseUrl: (parsed.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    pairingToken: parsed.pairingToken,
    reconnect: {
      initialDelayMs: parsed.reconnect?.initialDelayMs ?? 1000,
      maxDelayMs: parsed.reconnect?.maxDelayMs ?? 30000,
    },
  };
}
