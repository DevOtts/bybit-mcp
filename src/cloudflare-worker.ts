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
  setRequestHandler(matcher: { method: string; params?: Record<string, unknown> }, handler: (request: any) => Promise<any>): void;
  connect(transport?: any): Promise<void>;
  listTools(): Promise<any[]>;
  logger?: { info: (message: string) => void; error: (message: string) => void };
}

// For handling SSE connections
interface SSEClient {
  id: string;
  response: Response;
  controller: WritableStreamDefaultWriter<any>;
}

// We'll load the actual Server class at runtime
// For TypeScript compilation, we use the interface above
let ServerClass: new (options: ServerOptions, capabilities: ServerCapabilities) => Server;

// Try to load the Server class dynamically at runtime using await import()
// This code runs at the top level of the module, so await is permissible.
// ServerClass will be initialized before McpAgentDO or other exports are used.
try {
  // Attempt to import using the path that should be resolved by the SDK's "exports" map
  const sdkServerModule = await import('@modelcontextprotocol/sdk/server');
  if (sdkServerModule && (sdkServerModule as any).Server) {
    ServerClass = (sdkServerModule as any).Server;
    console.log("Successfully imported Server class from '@modelcontextprotocol/sdk/server'");
  } else {
    // Fallback to direct dist path if the export map based import didn't yield Server
    // This can happen if the "exports" map is not correctly processed or if Server is not on the default export
    console.warn("Server class not found via '@modelcontextprotocol/sdk/server'. Attempting direct import from '@modelcontextprotocol/sdk/dist/server/index.js'...");
    const sdkDistServerModule = await import('@modelcontextprotocol/sdk/dist/server/index.js');
    if (sdkDistServerModule && sdkDistServerModule.Server) {
      ServerClass = sdkDistServerModule.Server;
      console.log("Successfully imported Server class from '@modelcontextprotocol/sdk/dist/server/index.js'");
    } else {
      throw new Error("Server class not found in SDK via expected paths ('@modelcontextprotocol/sdk/server' or '@modelcontextprotocol/sdk/dist/server/index.js'). Check SDK structure and exports.");
    }
  }
} catch (e: any) {
  console.error("Failed to dynamically import Server class from SDK. Using MockServer as a fallback.", e.message, e.stack ? e.stack : '(no stack trace)');
  // Fallback implementation that will just log operations for development
  ServerClass = class MockServer implements Server {
    constructor(options: ServerOptions, capabilities: ServerCapabilities) {
      console.log("Created mock MCP server with options:", options, "capabilities:", capabilities);
      if (this.logger) { // logger might not be initialized if super constructor fails
        this.logger.warn("Critical: Using MockServer implementation due to SDK import failure.");
      } else {
        console.warn("Critical: Using MockServer implementation due to SDK import failure. Logger not available yet.");
      }
    }

    logger = {
      info: (message: string) => console.log(`[MCP MockServer Info] ${message}`),
      error: (message: string) => console.error(`[MCP MockServer Error] ${message}`),
      warn: (message: string) => console.warn(`[MCP MockServer Warn] ${message}`),
    };

    setRequestHandler(matcher: any, handler: any) {
      const logMessage = `MockServer: Registered request handler for method: ${matcher.method}, params: ${JSON.stringify(matcher.params || {})}`;
      console.log(logMessage);
      if (this.logger) this.logger.info(logMessage);
    }

    async connect(transport?: any) {
      const logMessage = "MockServer: Connected to transport (mock implementation)";
      console.log(logMessage);
      if (this.logger) this.logger.info(logMessage);
      return Promise.resolve();
    }

    async listTools() {
      const logMessage = "MockServer: listTools called (mock implementation)";
      console.log(logMessage);
      if (this.logger) this.logger.info(logMessage);
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

// Custom SSE transport for Cloudflare worker
class CloudflareSSETransport {
  private encoder: TextEncoder;
  private clients: Map<string, SSEClient>;
  private pendingMessages: Array<any>;
  private onMessageCallback?: (message: any) => void;

  constructor() {
    this.encoder = new TextEncoder();
    this.clients = new Map();
    this.pendingMessages = [];
  }

  async handleSSERequest(request: Request | CfRequest): Promise<Response> {
    const clientId = randomUUID();
    
    // Create a response with the appropriate headers for SSE
    const { readable, writable } = new TransformStream();
    const response = new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });

    const writer = writable.getWriter();
    const encoder = this.encoder;

    // Send initial connection message in JSON-RPC 2.0 format
    await writer.write(encoder.encode(`data: ${JSON.stringify({
      jsonrpc: "2.0", 
      method: "connection/established", 
      params: { id: clientId }
    })}\n\n`));

    // Store the client for future messages
    const client = {
      id: clientId,
      response,
      controller: writer,
    };
    this.clients.set(clientId, client);

    // Send any pending messages
    for (const message of this.pendingMessages) {
      await this.sendMessageToClient(client, message);
    }

    // Set up a heartbeat interval to keep the connection alive
    const heartbeatInterval = setInterval(async () => {
      try {
        if (this.clients.has(clientId)) {
          await client.controller.write(encoder.encode(`data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "heartbeat",
            params: { timestamp: Date.now() }
          })}\n\n`));
        } else {
          clearInterval(heartbeatInterval);
        }
      } catch (error) {
        this.clients.delete(clientId);
        clearInterval(heartbeatInterval);
      }
    }, 30000); // Send heartbeat every 30 seconds

    // Handle client disconnect
    // Use `(request as any).signal` to accommodate both Request and CfRequest types
    const reqSignal = (request as any).signal;
    if (reqSignal) {
      reqSignal.addEventListener('abort', () => {
        const logger = (this as any).serverLogger || console; // Access logger if available, else use console
        logger.info(`Client ${clientId} disconnected (request aborted). Cleaning up resources.`);
        this.clients.delete(clientId);
        clearInterval(heartbeatInterval);
        // Close the writer to signal the end of the stream
        writer.close().catch(e => logger.error(`Error closing writer for ${clientId}: ${(e as Error).message}`));
        this.removeClient(clientId); // Ensure client is removed from the map
      });
    }

    return response;
  }

  async handlePostMessage(request: Request | CfRequest): Promise<Response> {
    try {
      // Parse the incoming message
      const message = await request.json();
      
      // Process the message
      if (this.onMessageCallback) {
        this.onMessageCallback(message);
      }
      
      // Return a properly formatted JSON-RPC 2.0 response with the SAME ID from the request
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id, // Use the exact ID from the request, don't default
        result: {} // Empty result object for success
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: null, // No ID if we couldn't parse the request
        error: {
          code: -32700, // Parse error
          message: error.message || "Invalid JSON was received"
        }
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async sendMessage(message: any): Promise<void> {
    if (this.clients.size === 0) {
      // If there are no connected clients, store the message for later
      this.pendingMessages.push(message);
      return;
    }
    
    // Send to all connected clients
    for (const client of this.clients.values()) {
      await this.sendMessageToClient(client, message);
    }
  }

  private async sendMessageToClient(client: SSEClient, message: any): Promise<void> {
    try {
      // Ensure the message is properly formatted as JSON-RPC 2.0
      const formattedMessage = message.jsonrpc ? message : {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          message: typeof message === 'string' ? message : JSON.stringify(message),
          level: "info"
        }
      };
      
      await client.controller.write(this.encoder.encode(`data: ${JSON.stringify(formattedMessage)}\n\n`));
    } catch (error) {
      // If there's an error sending, remove the client
      this.clients.delete(client.id);
    }
  }

  setMessageCallback(callback: (message: any) => void): void {
    this.onMessageCallback = callback;
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }
}

// Standard Cloudflare Durable Object implementation
export class McpAgentDO {
  private state: DurableObjectState;
  private env: Env;
  private server: Server;
  private toolsMap: Map<string, BaseToolImplementation> = new Map();
  private sseTransport: CloudflareSSETransport;
  public envConfig: EnvConfig;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.envConfig = this.getWorkerEnvConfig(env);
    this.sseTransport = new CloudflareSSETransport();

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
    
    // Setup message handler for the SSE transport
    this.sseTransport.setMessageCallback((message) => {
      // Process incoming messages
      console.log("Received message:", message);
      // The SDK should handle routing the message to the appropriate handler
    });
    
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
    console.log("Initializing tools...");
    
    try {
      // Import tools dynamically
      const toolModules = [
        import('./tools/GetTicker.js'),
        import('./tools/GetOrderbook.js'),
        import('./tools/GetTrades.js'),
        import('./tools/GetKline.js'),
        import('./tools/GetMarketInfo.js'),
        import('./tools/GetInstrumentInfo.js'),
        import('./tools/GetWalletBalance.js'),
        import('./tools/GetPositions.js'),
        import('./tools/GetOrderHistory.js')
      ];
      
      // Wait for all imports to complete
      const modules = await Promise.all(toolModules);
      
      // Register each tool
      for (const module of modules) {
        if (module && module.default) {
          const ToolClass = module.default;
          const tool = new ToolClass(this.envConfig);
          this.addTool(tool);
        }
      }
      
      console.log(`Loaded ${this.toolsMap.size} tools`);
    } catch (error) {
      console.error("Error loading tools:", error);
    }
  }

  protected addTool(tool: BaseToolImplementation) {
    this.toolsMap.set(tool.name, tool);
    
    // Set up request handler for the tool
    this.server.setRequestHandler({
      method: "tools/call",
      params: { name: tool.name }
    }, async (request: ToolCallRequest) => {
      try {
        // Create a format that tool.toolCall can understand
        const pseudoRequest = {
          jsonrpc: "2.0",
          method: "tools/call",
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
    
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Mcp-Version, Mcp-Session-Id",
        }
      });
    }
    
    // Handle SSE endpoint
    if (url.pathname === "/sse") {
      return this.sseTransport.handleSSERequest(request);
    }
    
    // Handle message posting endpoint
    if (request.method === "POST" && url.pathname === "/mcp") {
      return this.sseTransport.handlePostMessage(request);
    }
    
    // Handle other MCP-related endpoints
    if (url.pathname.startsWith("/mcp")) {
      try {
        // Handle tools listing
        if (request.method === "GET" && url.pathname === "/mcp/tools") {
          const tools = Array.from(this.toolsMap.values()).map(tool => tool.toolDefinition);
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-list", // Fixed ID for tools listing
            result: { tools }
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // Handle tool calls
        if (request.method === "POST" && url.pathname === "/mcp/tools/call") {
          try {
            const bodyText = await request.text();
            const body = JSON.parse(bodyText) as { id?: string | number; name?: string; arguments?: Record<string, unknown> };
            
            const toolName = body.name || "";
            const toolArgs = body.arguments || {};
            // Use the exact request ID without defaulting
            const requestId = body.id;
            
            const tool = this.toolsMap.get(toolName);
            if (!tool) {
              return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                error: {
                  code: -32601, // Method not found code
                  message: `Tool '${toolName}' not found`
                }
              }), {
                status: 404, 
                headers: { "Content-Type": "application/json" }
              });
            }
            
            const result = await tool.toolCall({
              jsonrpc: "2.0",
              id: requestId, // Pass the original ID to the tool
              method: "tools/call",
              params: { name: toolName, arguments: toolArgs, sessionId: "worker-do-session" }
            } as any);
            
            // Tool results should already be in proper format, but ensure jsonrpc and id are set correctly
            const responseObj: {
              jsonrpc: string;
              id: string | number | undefined;
              result?: any;
              error?: any;
            } = {
              jsonrpc: "2.0",
              id: requestId, // Use the original request ID
              result: result.result || result // Handle both formats
            };
            
            // If there was an error, format it properly
            if (result.error) {
              delete responseObj.result; // Remove result property
              responseObj.error = result.error;
            }
            
            return new Response(JSON.stringify(responseObj), {
              headers: { "Content-Type": "application/json" }
            });
          } catch (error: any) {
            return new Response(JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700, // Parse error
                message: error.message || "Invalid JSON was received"
              }
            }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
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