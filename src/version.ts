import { z } from 'zod'
import packageJson from '../package.json' with { type: 'json' }

const PackageJsonSchema = z.object({
  version: z.string().min(1),
})

const BuildEnvSchema = z
  .object({
    FACTORY_BUILD_VERSION: z.string().min(1).optional(),
  })
  .passthrough()

function defaultVersionEnv(): Record<string, string | undefined> {
  return {
    FACTORY_BUILD_VERSION: process.env['FACTORY_BUILD_VERSION'],
  }
}

export function resolveFactoryVersion(
  env: Record<string, string | undefined> = defaultVersionEnv()
): string {
  const packageVersion = PackageJsonSchema.parse(packageJson).version
  const buildEnv = BuildEnvSchema.parse(env)
  return buildEnv.FACTORY_BUILD_VERSION ?? packageVersion
}

export const FACTORY_VERSION = resolveFactoryVersion()
