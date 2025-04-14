import type { AstroConfig, AstroIntegrationLogger } from "astro";
import { createHash } from "node:crypto";
import { parse, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Plugin } from "vite";
import type {
  AstroIconCollectionMap,
  IconCollection,
  IntegrationOptions,
} from "../typings/integration";
import loadLocalCollection from "./loaders/loadLocalCollection.js";
import loadIconifyCollections from "./loaders/loadIconifyCollections.js";

interface PluginContext extends Pick<AstroConfig, "root" | "output"> {
  logger: AstroIntegrationLogger;
}

export function createPlugin(
  { include = {}, iconDir = "src/icons", svgoOptions }: IntegrationOptions,
  ctx: PluginContext,
): Plugin {
  let collections: AstroIconCollectionMap | undefined;
  const { root } = ctx;
  const virtualModuleId = "virtual:astro-icon";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;
  const iconDirs = Array.isArray(iconDir) ? iconDir : [iconDir];

  return {
    name: "astro-icon",
    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId;
      }
    },

    async load(id) {
      if (id === resolvedVirtualModuleId) {
        try {
          if (!collections) {
            collections = await loadIconifyCollections({ root, include });
          }

          // Load and merge all local collections
          const localCollections = await Promise.all(
            iconDirs.map(dir => loadLocalCollection(dir, svgoOptions))
          );

          // Merge all local collections into one
          const local = localCollections.reduce((merged, current) => ({
            ...merged,
            icons: { ...merged.icons, ...current.icons },
            aliases: { ...merged.aliases, ...current.aliases },
            prefix: "local",
          }), { icons: {}, aliases: {}, prefix: "local" } as IconCollection);

          collections["local"] = local;
          logCollections(collections, { ...ctx, iconDir: iconDirs });
          await generateIconTypeDefinitions(Object.values(collections), root);
        } catch (ex) {
          // Failed to load the local collection
          ctx.logger.error("Failed to load local icon collections:", ex);
        }
        return `export default ${JSON.stringify(collections)};\nexport const config = ${JSON.stringify({ include })}`;
      }
    },
    configureServer({ watcher, moduleGraph }) {
      // Watch all icon directories
      iconDirs.forEach(dir => {
        watcher.add(`${dir}/**/*.svg`);
      });

      watcher.on("all", async (_, filepath: string) => {
        const parsedPath = parse(filepath);
        const isInIconDir = iconDirs.some(dir => {
          const resolvedIconDir = resolve(root.pathname, dir);
          return parsedPath.dir.startsWith(resolvedIconDir);
        });
        const isSvgFile = parsedPath.ext === ".svg";
        const isAstroConfig = parsedPath.name === "astro.config";

        if (!((isInIconDir && isSvgFile) || isAstroConfig)) return;

        console.log(`Local icons changed, reloading`);
        try {
          if (!collections) {
            collections = await loadIconifyCollections({ root, include });
          }

          // Load and merge all local collections
          const localCollections = await Promise.all(
            iconDirs.map(dir => loadLocalCollection(dir, svgoOptions))
          );

          // Merge all local collections into one
          const local = localCollections.reduce((merged, current) => ({
            ...merged,
            icons: { ...merged.icons, ...current.icons },
            aliases: { ...merged.aliases, ...current.aliases },
            prefix: "local",
          }), { icons: {}, aliases: {}, prefix: "local" } as IconCollection);

          collections["local"] = local;
          logCollections(collections, { ...ctx, iconDir: iconDirs });
          await generateIconTypeDefinitions(Object.values(collections), root);
          moduleGraph.invalidateAll();
        } catch (ex) {
          // Failed to load the local collection
          ctx.logger.error("Failed to reload local icon collections:", ex);
        }
        return `export default ${JSON.stringify(collections)};\nexport const config = ${JSON.stringify({ include })}`;
      });
    },
  };
}

function logCollections(
  collections: AstroIconCollectionMap,
  { logger, iconDir }: PluginContext & { iconDir: string | string[] },
) {
  if (Object.keys(collections).length === 0) {
    logger.warn("No icons detected!");
    return;
  }
  const names: string[] = Object.keys(collections).filter((v) => v !== "local");
  if (collections["local"]) {
    const dirs = Array.isArray(iconDir) ? iconDir : [iconDir];
    names.unshift(...dirs);
  }
  logger.info(`Loaded icons from ${names.join(", ")}`);
}

async function generateIconTypeDefinitions(
  collections: IconCollection[],
  rootDir: URL,
  defaultPack = "local",
): Promise<void> {
  const typeFile = new URL("./.astro/icon.d.ts", rootDir);
  await ensureDir(new URL("./", typeFile));
  const oldHash = await tryGetHash(typeFile);
  const currentHash = collectionsHash(collections);
  if (currentHash === oldHash) {
    return;
  }
  await writeFile(
    typeFile,
    `// Automatically generated by astro-icon
// ${currentHash}

declare module 'virtual:astro-icon' {
\texport type Icon = ${collections.length > 0
      ? collections
        .map((collection) =>
          Object.keys(collection.icons)
            .concat(Object.keys(collection.aliases ?? {}))
            .map(
              (icon) =>
                `\n\t\t| "${collection.prefix === defaultPack
                  ? ""
                  : `${collection.prefix}:`
                }${icon}"`,
            ),
        )
        .flat(1)
        .join("")
      : "never"
    };
}`,
  );
}

function collectionsHash(collections: IconCollection[]): string {
  const hash = createHash("sha256");
  for (const collection of collections) {
    hash.update(collection.prefix);
    hash.update(
      Object.keys(collection.icons)
        .concat(Object.keys(collection.aliases ?? {}))
        .sort()
        .join(","),
    );
  }
  return hash.digest("hex");
}

async function tryGetHash(path: URL): Promise<string | void> {
  try {
    const text = await readFile(path, { encoding: "utf-8" });
    return text.split("\n", 3)[1].replace("// ", "");
  } catch { }
}

async function ensureDir(path: URL): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch { }
}
