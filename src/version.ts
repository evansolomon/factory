import { z } from 'zod'
import packageJson from '../package.json' with { type: 'json' }

const PackageJsonSchema = z.object({
  version: z.string().min(1),
})

export const FACTORY_VERSION = PackageJsonSchema.parse(packageJson).version
