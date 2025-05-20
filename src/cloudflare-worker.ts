import { type DurableObjectNamespace, type DurableObjectState, type ExecutionContext, type Request as CfRequest } from '@cloudflare/workers-types';
// We need to use Cloudflare's types for typechecking but use the global types in the code
import { z } from "zod";
import { BaseToolImplementation } from "./tools/BaseTool.js";
import { EnvConfig } from "./env.js";
import { CONSTANTS } from "./constants.js";
import { randomUUID } from 'node:crypto'; // For session IDs if needed

// Bypass type checking issues with Response types
// There's a mismatch between Cloudflare's Response type and standard web Response type
// For deployment, using any is acceptable here
type WorkerResponse = any;

// Define types for the SDK classes we need based on the documentation
// This allows TypeScript to check our code without having to resolve the actual imports
interface ServerOptions {
  name: string;
  version: string;
}

interface ServerCapabilities {
  capabilities?: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
    logging?: Record<string, unknown>;
  };
}

interface ToolCallRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    [key: string]: unknown;
  };
  method: string;
  [key: string]: unknown;
}

// Server class is from the MCP SDK
interface Server {
  setRequestHandler(matcher: { method: string; params: Record<string, unknown> }, handler: (request: ToolCallRequest) => Promise<any>): void;
  connect(transport: any): Promise<void>;
  listTools(): Promise<any[]>;
  logger?: { info: (message: string) => void; error: (message: string) => void };
}

// We'll load the actual Server class at runtime
// For TypeScript compilation, we use the interface above
let ServerClass: new (options: ServerOptions, capabilities: ServerCapabilities) => Server;

// Try to load the Server class dynamically at runtime
try {
  // Using CommonJS require for runtime loading (wrapped in dummy function to satisfy TypeScript)
  const dynamicRequire = (module: string) => {
    // This function exists only to inform TypeScript of the signature.
    // At runtime, it's replaced with actual CommonJS require.
    return {} as any; 
  };
  // We'll try all possible paths where Server might be exported
  const paths = [
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/dist/server/index.js',
    '@modelcontextprotocol/sdk/server'
  ];
  
  let sdk: any = null;
  for (const path of paths) {
    try {
      sdk = require(path);
      if (sdk && sdk.Server) {
        console.log(`Found Server class in: ${path}`);
        break;
      }
    } catch (e: any) {
      console.warn(`Failed to import from ${path}: ${e.message}`);
    }
  }
  
  if (sdk && sdk.Server) {
    ServerClass = sdk.Server;
  } else {
    throw new Error("Server class not found in any of the expected paths");
  }
} catch (e: any) {
  console.error("Failed to import Server class:", e);
  // Fallback implementation that will just log operations for development
  ServerClass = class MockServer implements Server {
    constructor(options: ServerOptions, capabilities: ServerCapabilities) {
      console.log("Created mock MCP server with options:", options, capabilities);
    }
    
    logger = {
      info: (message: string) => console.log(`[MCP Server Info] ${message}`),
      error: (message: string) => console.error(`[MCP Server Error] ${message}`)
    };
    
    setRequestHandler(matcher: any, handler: any) {
      console.log(`Registered request handler for method: ${matcher.method}`);
    }
    
    async connect(transport: any) {
      console.log("Connected to transport (mock implementation)");
    }
    
    async listTools() {
      return [];
    }
  };
}

// Define the environment expected by the Durable Object
interface Env {
  MCP_AGENT: DurableObjectNamespace;
  BYBIT_API_KEY: string;
  BYBIT_API_SECRET: string;
  BYBIT_USE_TESTNET: string;
  DEBUG?: string;
}

// Standard Cloudflare Durable Object implementation
export class McpAgentDO {
  private state: DurableObjectState;
  private env: Env;
  private server: Server;
  private toolsMap: Map<string, BaseToolImplementation> = new Map();
  public envConfig: EnvConfig;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.envConfig = this.getWorkerEnvConfig(env);

    // Initialize Server with the required parameters
    this.server = new ServerClass(
      {
        name: CONSTANTS.PROJECT_NAME,
        version: CONSTANTS.PROJECT_VERSION,
      },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          logging: {}
        }
      }
    );
    
    this.initializeTools();
  }

  private getWorkerEnvConfig(env: Env): EnvConfig {
    return {
      apiKey: env.BYBIT_API_KEY,
      apiSecret: env.BYBIT_API_SECRET,
      useTestnet: env.BYBIT_USE_TESTNET === "true",
      debug: env.DEBUG === "true",
    };
  }

  async initializeTools() {
    console.log("Tool initialization: Manually import and register tools from ./tools/* here.");
    // Example (commented out):
    // import GetTicker from './tools/GetTicker';
    // const getTickerTool = new GetTicker(this.envConfig);
    // this.addTool(getTickerTool);
  }

  protected addTool(tool: BaseToolImplementation) {
    this.toolsMap.set(tool.name, tool);
    
    // The Server class likely has a different way to register tools
    // compared to what we initially assumed. We'll adapt based on the SDK.
    this.server.setRequestHandler({
      method: "tools/call",
      params: { name: tool.name }
    }, async (request: ToolCallRequest) => {
      try {
        // Create a format that tool.toolCall can understand
        const pseudoRequest = {
          jsonrpc: "2.0",
          method: "callTool",
          params: { 
            name: tool.name, 
            arguments: request.params.arguments || {}, 
            sessionId: "worker-do-session" 
          }
        };
        
        return await tool.toolCall(pseudoRequest as any);
      } catch (error: any) {
        console.error(`Error calling tool ${tool.name}:`, error);
        return {
          error: {
            code: -32000,
            message: error.message || `Error calling tool ${tool.name}`
          }
        };
      }
    });
    
    console.log(`Registered tool: ${tool.name}`);
  }

  // Standard Durable Object fetch handler
  async fetch(request: CfRequest): Promise<WorkerResponse> {
    // Basic implementation for MCP endpoints
    const url = new URL(request.url);
    
    if (url.pathname.startsWith("/mcp")) {
      try {
        // Basic implementation - needs to be expanded based on MCP protocol
        if (request.method === "GET" && url.pathname === "/mcp/tools") {
          const tools = Array.from(this.toolsMap.values()).map(tool => tool.toolDefinition);
          return new Response(JSON.stringify(tools), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // Handle tool calls
        if (request.method === "POST" && url.pathname === "/mcp/tools/call") {
          const bodyText = await request.text();
          const body = JSON.parse(bodyText) as { name?: string; arguments?: Record<string, unknown> };
          
          const toolName = body.name || "";
          const toolArgs = body.arguments || {};
          
          const tool = this.toolsMap.get(toolName);
          if (!tool) {
            return new Response(JSON.stringify({ error: `Tool '${toolName}' not found` }), {
              status: 404, 
              headers: { "Content-Type": "application/json" }
            });
          }
          
          const result = await tool.toolCall({
            jsonrpc: "2.0",
            method: "callTool",
            params: { name: toolName, arguments: toolArgs, sessionId: "worker-do-session" }
          } as any);
          
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // For other MCP requests, we'll need to integrate with the SDK's
        // request handling flow. This will require investigation and adaptation.
        if (request.method === "POST" && url.pathname === "/mcp") {
          // This would need to be implemented based on how Server handles raw requests
          // For now, just return a meaningful error
          return new Response(JSON.stringify({
            error: "Direct MCP protocol handling not yet implemented"
          }), {
            status: 501,
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // If we get here, the specific MCP endpoint is not implemented
        return new Response(JSON.stringify({ error: "MCP endpoint not implemented" }), {
          status: 501,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error: any) {
        console.error("Error handling MCP request:", error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    
    return new Response("Durable Object endpoint not found", { status: 404 });
  }
}

export default {
  async fetch(request: CfRequest, env: Env, ctx: ExecutionContext): Promise<WorkerResponse> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(JSON.stringify({
        status: "ok",
        message: "Bybit MCP Server (Cloudflare Worker) is running",
        projectName: CONSTANTS.PROJECT_NAME,
        projectVersion: CONSTANTS.PROJECT_VERSION,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Mcp-Version, Mcp-Session-Id",
        }
      });
    }

    if (url.pathname.startsWith("/mcp") || url.pathname.startsWith("/sse")) {
      try {
        const doId = env.MCP_AGENT.idFromName("bybit-mcp-agent-v1");
        const stub = env.MCP_AGENT.get(doId);
        return await stub.fetch(request);
      } catch (e: any) {
        console.error(`Durable Object fetch error for ${url.pathname}:`, e.message, e.stack);
        return new Response(`Error routing to Durable Object: ${e.message}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};