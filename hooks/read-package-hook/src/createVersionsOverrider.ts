import path from 'path'
import semver from 'semver'
import partition from 'ramda/src/partition'
import { type Dependencies, type PackageManifest, type ReadPackageHook } from '@pnpm/types'
import { PnpmError } from '@pnpm/error'
import { parseOverrides, type VersionOverride as VersionOverrideBase } from '@pnpm/parse-overrides'
import normalizePath from 'normalize-path'
import { matchCatalogResolveResult, resolveFromCatalog } from '@pnpm/catalogs.resolver'
import { type Catalogs } from '@pnpm/catalogs.types'
import { isIntersectingRange } from './isIntersectingRange'

export function createVersionsOverrider (
  overrides: Record<string, string>,
  rootDir: string,
  options: {
    catalogs: Catalogs
  }
): ReadPackageHook {
  const parsedOverrides = tryParseOverrides(overrides)
  const _resolveFromCatalog = resolveFromCatalog.bind(null, options.catalogs)
  const [versionOverrides, genericVersionOverrides] = partition(({ parentPkg }) => parentPkg != null,
    parsedOverrides
      .map((override) => {
        const catalogLookup = matchCatalogResolveResult(_resolveFromCatalog({
          pref: override.newPref,
          alias: override.targetPkg.name,
        }), {
          found: (result) => result.resolution,
          unused: () => undefined,
          misconfiguration: (result) => {
            throw result.error
          },
        })
        return {
          ...override,
          newPref: catalogLookup != null ? catalogLookup.specifier : override.newPref,
          localTarget: createLocalTarget(override, rootDir),
        }
      })
  ) as [VersionOverrideWithParent[], VersionOverride[]]
  return ((manifest: PackageManifest, dir?: string) => {
    const versionOverridesWithParent = versionOverrides.filter(({ parentPkg }) => {
      return (
        parentPkg.name === manifest.name &&
        (!parentPkg.pref || semver.satisfies(manifest.version, parentPkg.pref))
      )
    })
    overrideDepsOfPkg({ manifest, dir }, versionOverridesWithParent, genericVersionOverrides)

    return manifest
  }) as ReadPackageHook
}

function tryParseOverrides (overrides: Record<string, string>): VersionOverrideBase[] {
  try {
    return parseOverrides(overrides)
  } catch (e) {
    throw new PnpmError('INVALID_OVERRIDES_SELECTOR', `${(e as PnpmError).message} in pnpm.overrides`)
  }
}

interface LocalTarget {
  protocol: LocalProtocol
  absolutePath: string
  specifiedViaRelativePath: boolean
}

type LocalProtocol = 'link:' | 'file:'

function createLocalTarget (override: VersionOverrideBase, rootDir: string): LocalTarget | undefined {
  let protocol: LocalProtocol | undefined
  if (override.newPref.startsWith('file:')) {
    protocol = 'file:'
  } else if (override.newPref.startsWith('link:')) {
    protocol = 'link:'
  } else {
    return undefined
  }
  const pkgPath = override.newPref.substring(protocol.length)
  const specifiedViaRelativePath = !path.isAbsolute(pkgPath)
  const absolutePath = specifiedViaRelativePath ? path.join(rootDir, pkgPath) : pkgPath
  return { absolutePath, specifiedViaRelativePath, protocol }
}

interface VersionOverride extends VersionOverrideBase {
  localTarget?: LocalTarget
}

interface VersionOverrideWithParent extends VersionOverride {
  parentPkg: {
    name: string
    pref?: string
  }
}

function overrideDepsOfPkg (
  { manifest, dir }: { manifest: PackageManifest, dir: string | undefined },
  versionOverrides: VersionOverrideWithParent[],
  genericVersionOverrides: VersionOverride[]
): void {
  if (manifest.dependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.dependencies, dir)
  if (manifest.optionalDependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.optionalDependencies, dir)
  if (manifest.devDependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.devDependencies, dir)
  if (manifest.peerDependencies != null) overrideDeps(versionOverrides, genericVersionOverrides, manifest.peerDependencies, dir)
}

function overrideDeps (
  versionOverrides: VersionOverrideWithParent[],
  genericVersionOverrides: VersionOverride[],
  deps: Dependencies,
  dir: string | undefined
): void {
  for (const [name, pref] of Object.entries(deps)) {
    const versionOverride =
    pickMostSpecificVersionOverride(
      versionOverrides.filter(
        ({ targetPkg }) =>
          targetPkg.name === name && isIntersectingRange(targetPkg.pref, pref)
      )
    ) ??
    pickMostSpecificVersionOverride(
      genericVersionOverrides.filter(
        ({ targetPkg }) =>
          targetPkg.name === name && isIntersectingRange(targetPkg.pref, pref)
      )
    )
    if (!versionOverride) continue

    if (versionOverride.localTarget) {
      deps[versionOverride.targetPkg.name] = `${versionOverride.localTarget.protocol}${resolveLocalOverride(versionOverride.localTarget, dir)}`
      continue
    }
    deps[versionOverride.targetPkg.name] = versionOverride.newPref
  }
}

function resolveLocalOverride ({ specifiedViaRelativePath, absolutePath }: LocalTarget, pkgDir?: string): string {
  return specifiedViaRelativePath && pkgDir
    ? normalizePath(path.relative(pkgDir, absolutePath))
    : absolutePath
}

function pickMostSpecificVersionOverride (versionOverrides: VersionOverride[]): VersionOverride | undefined {
  return versionOverrides.sort((a, b) => isIntersectingRange(b.targetPkg.pref ?? '', a.targetPkg.pref ?? '') ? -1 : 1)[0]
}
