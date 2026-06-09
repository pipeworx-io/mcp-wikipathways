interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * WikiPathways MCP — open community pathway database.
 *
 * Search biological pathways by name (optionally per organism), list an
 * organism's pathways, get a pathway's metadata + link. Pathways map
 * genes/proteins/metabolites in processes like glycolysis, apoptosis,
 * signaling. Keyless. Complements KEGG/Reactome.
 */


const BASE = 'https://www.wikipathways.org/json';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

interface Pathway {
  id: string;
  url: string;
  name: string;
  species: string;
  revision: string;
}

interface Organism {
  latin: string;
  common: string;
  'two-letter-code': string;
  pathways: Pathway[];
}

const tools: McpToolExport['tools'] = [
  {
    name: 'search_pathways',
    description:
      'Search WikiPathways (open community pathway database) for biological pathways by name. Pathways map genes/proteins/metabolites in processes like glycolysis, apoptosis, or signaling. Optionally restrict to one organism by Latin or common name. Keyless. Complements KEGG/Reactome.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match in the pathway name (case-insensitive), e.g. "glycolysis", "apoptosis".' },
        organism: { type: 'string', description: 'Optional. Restrict to an organism by Latin or common name, e.g. "Homo sapiens" or "human".' },
        limit: { type: 'number', description: 'Max results (default 25, max 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_pathways',
    description:
      "List all WikiPathways pathways for a single organism. Give a Latin or common name, e.g. \"Homo sapiens\", \"human\", or \"mouse\". Returns each pathway's id, name, link, and last revision. Keyless.",
    inputSchema: {
      type: 'object',
      properties: {
        organism: { type: 'string', description: 'Organism by Latin or common name, e.g. "Homo sapiens", "human", "mouse".' },
        limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      },
      required: ['organism'],
    },
  },
  {
    name: 'get_pathway',
    description:
      'Get metadata and a viewer link for one WikiPathways pathway by its WikiPathways id (e.g. "WP554"). Returns name, species, revision, and a human-viewable diagram URL. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A WikiPathways id like "WP554".' },
      },
      required: ['id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_pathways':
        return await searchPathways(args);
      case 'list_pathways':
        return await listPathways(args);
      case 'get_pathway':
        return await getPathway(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchPathways(args: Record<string, unknown>): Promise<unknown> {
  const query = reqStr(args, 'query');
  const organism = typeof args.organism === 'string' ? args.organism.trim() : '';
  const limit = clampLimit(args.limit, 25, 100);

  const organisms = await fetchCatalog();
  const q = query.toLowerCase();
  const orgNeedle = norm(organism);

  const results: Array<{ id: string; name: string; species: string; url: string }> = [];
  for (const org of organisms) {
    if (orgNeedle) {
      const latin = norm(org.latin);
      const common = norm(org.common);
      if (!latin.includes(orgNeedle) && !common.includes(orgNeedle)) continue;
    }
    for (const p of org.pathways) {
      if (p.name && p.name.toLowerCase().includes(q)) {
        results.push({ id: p.id, name: p.name, species: p.species, url: p.url });
      }
    }
  }

  return { count: results.length, pathways: results.slice(0, limit) };
}

async function listPathways(args: Record<string, unknown>): Promise<unknown> {
  const organism = reqStr(args, 'organism');
  const limit = clampLimit(args.limit, 50, 200);

  const organisms = await fetchCatalog();
  const needle = norm(organism);

  const match = organisms.find((org) => norm(org.latin).includes(needle) || norm(org.common).includes(needle));
  if (!match) {
    return { error: "organism not found; try a Latin name like 'Homo sapiens'", organism };
  }

  const pathways = match.pathways.slice(0, limit).map((p) => ({ id: p.id, name: p.name, url: p.url, revision: p.revision }));
  return { organism: match.latin, count: match.pathways.length, pathways };
}

async function getPathway(args: Record<string, unknown>): Promise<unknown> {
  const id = reqStr(args, 'id');
  const data = (await httpGet(`/getPathwayInfo.json?pwId=${encodeURIComponent(id)}`)) as { pathwayInfo?: Pathway[] };
  const info = Array.isArray(data.pathwayInfo) ? data.pathwayInfo[0] : undefined;
  if (!info) {
    return { error: 'pathway not found', id };
  }
  return {
    id: info.id,
    name: info.name,
    species: info.species,
    revision: info.revision,
    url: info.url,
    viewer_url: `https://www.wikipathways.org/pathways/${encodeURIComponent(info.id)}.html`,
  };
}

async function fetchCatalog(): Promise<Organism[]> {
  const data = (await httpGet('/listPathways.json')) as { organisms?: Organism[] };
  return Array.isArray(data.organisms) ? data.organisms : [];
}

async function httpGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`WikiPathways: ${res.status} ${body}`);
  }
  return res.json();
}

/** Normalize organism names: lowercase, underscores/spaces unified. */
function norm(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ').trim();
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  if (n < 1) return 1;
  return Math.min(n, max);
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing.`);
  return v.trim();
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
