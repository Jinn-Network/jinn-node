import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

type LoggingModule = typeof import('../../logging/index.js');

// Built at runtime after env is loaded and tools are imported
export let serverTools: { name: string; schema: any; handler: (params: any) => any }[] = [];

// List of MCP tool names that are registered in this server
// This is used for validation/testing to ensure tool policy matches actual registrations
export const REGISTERED_MCP_TOOLS = [
  'get_details',
  'dispatch_new_job',
  'create_artifact',
  'create_measurement',
  'dispatch_existing_job',
  'search_jobs',
  'search_artifacts',
  'search_similar_situations',
  'inspect_situation',
  'get_file_contents',
  'search_code',
  'list_commits',
  'process_branch',
  'template_create',
  'template_query',
  'template_update',
  'template_delete',
  'list_tools', // Special tool registered separately
  'verify_trade_ideas',
  // Blog management tools
  'blog_create_post',
  'blog_list_posts',
  'blog_delete_post',
  'blog_get_post',
  'blog_get_stats',
  'blog_get_top_pages',
  'blog_get_referrers',
  'blog_get_metrics',
  'blog_get_pageviews',
  'blog_get_performance_summary',
  // Telegram messaging tools
  'telegram_send_message',
  'telegram_send_photo',
  'telegram_send_document',
  // Inspection tools (workstream/job analysis)
  'inspect_job_run',
  'inspect_job',
  'inspect_workstream',
  // Venture & service registry tools
  'venture_mint',
  'venture_query',
  'venture_update',
  'venture_delete',
  'service_registry',
  'search_services',
] as const;

async function main() {
  let logging: LoggingModule | null = null;
  let mcpLogger: LoggingModule['mcpLogger'] | null = null;
  let serializeError: LoggingModule['serializeError'] | null = null;

  try {
    // Force all Pino logs to stderr to avoid polluting JSON-RPC stdout
    process.env.FORCE_STDERR = 'true';

    // Load logging utilities after FORCE_STDERR is set so the logger observes the flag
    logging = await import('../../logging/index.js');
    mcpLogger = logging.mcpLogger;
    serializeError = logging.serializeError;

    if (process.env.MCP_FORCE_DIAGNOSTIC_LOG === 'true' && mcpLogger) {
      mcpLogger.info({ diagnostic: true }, 'MCP stdout cleanliness test probe');
    }

    // Ensure .env variables are available to all tools before they are imported/registered
    const envModule = await import('./tools/shared/env.js');
    envModule.loadEnvOnce();

    // Suppress noisy stdout loggers to protect MCP stdio JSON stream
    // Only allow warnings/errors to reach stderr (Cursor will show those as errors)
    const level = (process.env.MCP_LOG_LEVEL || 'error').toLowerCase();
    const noop = () => { };
    // Always prevent stdout logging
    (console as any).log = noop;
    (console as any).info = noop;
    (console as any).debug = level === 'debug' ? console.debug.bind(console) : noop;
    // Route warnings to stderr; errors already go to stderr
    (console as any).warn = console.error.bind(console);

    // Dynamically import tools after env is loaded to guarantee availability
    const tools = await import('./tools/index.js');

    const server = new McpServer({
      name: 'metacog-mcp',
      version: '0.1.0',
    });

    // Build serverTools from imported tool modules (core tools only)
    serverTools = [
      { name: 'get_details', schema: tools.getDetailsSchema, handler: tools.getDetails },
      { name: 'dispatch_new_job', schema: tools.dispatchNewJobSchema, handler: tools.dispatchNewJob },
      { name: 'create_artifact', schema: tools.createArtifactSchema, handler: tools.createArtifact },
      { name: 'create_measurement', schema: tools.createMeasurementSchema, handler: tools.createMeasurement },
      { name: 'dispatch_existing_job', schema: tools.dispatchExistingJobSchema, handler: tools.dispatchExistingJob },
      { name: 'search_jobs', schema: tools.searchJobsSchema, handler: tools.searchJobs },
      { name: 'search_artifacts', schema: tools.searchArtifactsSchema, handler: tools.searchArtifacts },
      { name: 'search_similar_situations', schema: tools.searchSimilarSituationsSchema, handler: tools.searchSimilarSituations },
      { name: 'inspect_situation', schema: tools.inspectSituationSchema, handler: tools.inspectSituation },
      { name: 'get_file_contents', schema: tools.getFileContentsSchema, handler: tools.getFileContents },
      { name: 'search_code', schema: tools.searchCodeSchema, handler: tools.searchCode },
      { name: 'list_commits', schema: tools.listCommitsSchema, handler: tools.listCommits },
      { name: 'process_branch', schema: tools.process_branch_schema, handler: tools.process_branch },
      // Template CRUD tools
      { name: 'template_create', schema: tools.templateCreateSchema, handler: tools.templateCreate },
      { name: 'template_query', schema: tools.templateQuerySchema, handler: tools.templateQuery },
      { name: 'template_update', schema: tools.templateUpdateSchema, handler: tools.templateUpdate },
      { name: 'template_delete', schema: tools.templateDeleteSchema, handler: tools.templateDelete },
      // Blog management tools
      { name: 'blog_create_post', schema: tools.blogCreatePostSchema, handler: tools.blogCreatePost },
      { name: 'blog_list_posts', schema: tools.blogListPostsSchema, handler: tools.blogListPosts },
      { name: 'blog_delete_post', schema: tools.blogDeletePostSchema, handler: tools.blogDeletePost },
      { name: 'blog_get_post', schema: tools.blogGetPostSchema, handler: tools.blogGetPost },
      { name: 'blog_get_stats', schema: tools.blogGetStatsSchema, handler: tools.blogGetStats },
      { name: 'blog_get_top_pages', schema: tools.blogGetTopPagesSchema, handler: tools.blogGetTopPages },
      { name: 'blog_get_referrers', schema: tools.blogGetReferrersSchema, handler: tools.blogGetReferrers },
      { name: 'blog_get_metrics', schema: tools.blogGetMetricsSchema, handler: tools.blogGetMetrics },
      { name: 'blog_get_pageviews', schema: tools.blogGetPageviewsSchema, handler: tools.blogGetPageviews },
      { name: 'blog_get_performance_summary', schema: tools.blogGetPerformanceSummarySchema, handler: tools.blogGetPerformanceSummary },
      // Telegram messaging tools
      { name: 'telegram_send_message', schema: tools.telegramSendMessageSchema, handler: tools.telegramSendMessage },
      { name: 'telegram_send_photo', schema: tools.telegramSendPhotoSchema, handler: tools.telegramSendPhoto },
      { name: 'telegram_send_document', schema: tools.telegramSendDocumentSchema, handler: tools.telegramSendDocument },
      // Inspection tools (workstream/job analysis)
      { name: 'inspect_job_run', schema: tools.inspectJobRunSchema, handler: tools.inspectJobRun },
      { name: 'inspect_job', schema: tools.inspectJobSchema, handler: tools.inspectJob },
      { name: 'inspect_workstream', schema: tools.inspectWorkstreamSchema, handler: tools.inspectWorkstream },
      // Venture & service registry tools
      { name: 'venture_mint', schema: tools.ventureMintSchema, handler: tools.ventureMint },
      { name: 'venture_query', schema: tools.ventureQuerySchema, handler: tools.ventureQuery },
      { name: 'venture_update', schema: tools.ventureUpdateSchema, handler: tools.ventureUpdate },
      { name: 'venture_delete', schema: tools.ventureDeleteSchema, handler: tools.ventureDelete },
      { name: 'service_registry', schema: tools.serviceRegistrySchema, handler: tools.serviceRegistry },
      { name: 'search_services', schema: tools.searchServicesSchema, handler: tools.searchServices },
    ];

    // Initialize the dynamic tool registry (internal) for dynamic enums
    const toolRegistryModule = await import('./tools/shared/tool-registry.js');
    toolRegistryModule.setToolRegistry(serverTools);

    // Register all tools
    for (const tool of serverTools) {
      // get_schema is not registered; legacy tools removed
      server.registerTool(tool.name, tool.schema as any, tool.handler);
    }

    // Fix create_measurement inputSchema to allow additional properties
    // The MCP SDK wraps inputSchema in z.object() which loses passthrough()
    // We need to replace it with the original schema that has passthrough()
    const serverAny = server as any;
    if (serverAny._registeredTools?.['create_measurement']) {
      serverAny._registeredTools['create_measurement'].inputSchema = tools.createMeasurementFlatParams;
    }

    // Expose list_tools for operator introspection (agents may ignore)
    server.registerTool('list_tools', tools.listToolsSchema as any, (params) => tools.listTools(params, serverTools));

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (e) {
    if (mcpLogger && serializeError) {
      mcpLogger.fatal({ error: serializeError(e) }, 'Error starting MCP server');
    } else {
      console.error('Error starting MCP server', e);
    }
    process.exit(1);
  }
}

main();
