import { createJsonRpcError, isJsonRpcRequest } from "./errors.js";
import { buildMcpTools } from "./tools.js";

export function createMcpServer({
    rootDir,
    enableWrite = false,
    enableTests = false,
    enableExternalSideEffects = false,
    runCli,
    version = "0.0.0",
} = {}) {
    const tools = buildMcpTools({
        rootDir,
        enableWrite,
        enableTests,
        enableExternalSideEffects,
        runCli,
    });
    let initialized = false;

    function success(id, result) {
        if (id === undefined || id === null) {
            return null;
        }
        return {
            jsonrpc: "2.0",
            id,
            result,
        };
    }

    function failure(id, error) {
        if (id === undefined || id === null) {
            return null;
        }
        return {
            jsonrpc: "2.0",
            id,
            error,
        };
    }

    async function handle(message) {
        if (!isJsonRpcRequest(message)) {
            return null;
        }

        const { id, method, params } = message;

        try {
            if (method === "initialize") {
                initialized = true;
                return success(id, {
                    protocolVersion: "2024-11-05",
                    serverInfo: {
                        name: "repo-context-kit",
                        version,
                    },
                    capabilities: {
                        tools: {},
                    },
                });
            }

            if (!initialized) {
                return failure(
                    id,
                    createJsonRpcError(-32002, "Server not initialized"),
                );
            }

            if (method === "tools/list") {
                return success(id, { tools: tools.listTools() });
            }

            if (method === "tools/call") {
                const name = params?.name;
                const args = params?.arguments;
                if (typeof name !== "string") {
                    return failure(id, createJsonRpcError(-32602, "params.name must be a string"));
                }
                const result = await tools.callTool(name, args);
                return success(id, result);
            }

            if (method === "ping") {
                return success(id, {});
            }

            if (method === "shutdown") {
                return success(id, {});
            }

            return failure(id, createJsonRpcError(-32601, `Method not found: ${method}`));
        } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            const data = error && typeof error === "object" && "code" in error ? { code: error.code } : undefined;
            return failure(id, createJsonRpcError(-32603, messageText, data));
        }
    }

    return {
        handle,
    };
}
