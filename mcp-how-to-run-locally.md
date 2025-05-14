# How to Run an MCP Server Sample Locally: Troubleshooting Guide

## Setup

1. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the server:
   ```bash
   python calculator_mcp.py
   ```

## Server Details

- The MCP server runs using stdio transport for direct communication with Cursor
- Logging is written to `/tmp/calculator_mcp_debug.log` to help with troubleshooting

## Usage with Cursor

To use this with Cursor's MCP client:

1. Configure the calculator MCP server in `.cursor/mcp.json` like:
   ```json
   "calculator-mcp": {
     "command": "/path/to/venv/bin/python",
     "args": ["/path/to/calculator-mcp/calculator_mcp.py"]
   }
   ```

2. In Cursor, navigate to the MCP Servers section
3. Connect to the calculator-mcp server
4. Select and use the `calculate` tool

## Example Usage

```
Tool: calculate
Input: {"expression": "2+2*3"}
Result: 8
```

## Troubleshooting Guide: Our Journey to a Working Cursor MCP Server

This section documents our step-by-step journey to get the calculator MCP server working with Cursor. It covers the various approaches we tried, the errors we encountered, and the final solution. This information may be valuable if you're developing your own MCP server for Cursor.

### Approach 1: FastAPI HTTP Server (fastapi_approach.py)

**What we did:**
- Created a FastAPI server with a `/calculate` endpoint
- Used asteval for safe expression evaluation
- Configured Cursor to run the server using uvicorn

**Configuration in .cursor/mcp.json:**
```json
"calculator-mcp": {
  "command": "bash", 
  "args": [
    "-c",
    "cd /path/to/calculator-mcp && /path/to/venv/bin/python -m uvicorn fastapi_approach:app --host 0.0.0.0 --port 7123 --reload"
  ]
}
```

**Error:**
- "Client closed" error in Cursor MCP
- The server started but Cursor couldn't communicate with it

**Why it failed:**
- Cursor's MCP system expects servers to use a specific protocol (Stdio or SSE) for communication
- Our FastAPI server was a regular HTTP API, not an MCP-compatible server

### Approach 2: FastMCP with SSE Transport (calculator_mcp_first_approach.py)

**What we did:**
- Switched to FastMCP library
- Created a server with `calculate` and `calculate_with_steps` tools
- Configured it to run with the SSE transport

**Code:**
```python
if __name__ == "__main__":
    mcp.run(transport="sse", port=7123)
```

**Error:**
- Same "Client closed" error
- Cursor's direct command execution expects stdio, not SSE

**Why it failed:**
- When Cursor runs the command from `.cursor/mcp.json`, it expects to communicate with the process via standard input/output (stdio)
- Our script was starting only an SSE server, so the stdio connection Cursor expected was never established

### Approach 3: FastMCP with Default Transport (Stdio)

**What we did:**
- Modified the code to use the default transport (stdio)
- Updated `.cursor/mcp.json` to run the script directly

**Code:**
```python
if __name__ == "__main__":
    mcp.run()  # Default is stdio
```

**Error:**
- Still saw "Client closed" error
- Cursor was executing the script but communication wasn't working

**Why it failed:**
- The script was running, but some other factor was preventing proper stdio communication

### Approach 4: Using FastMCP CLI Tool

**What we did:**
- Tried using the FastMCP CLI tool directly
- Updated `.cursor/mcp.json` to use `fastmcp run` command

**Configuration:**
```json
"calculator-mcp": {
  "command": "bash",
  "args": [
    "-c",
    "cd /path/to/calculator-mcp && /path/to/venv/bin/fastmcp run calculator_mcp_first_approach.py:mcp"
  ]
}
```

**Error:**
- `No module named fastmcp.__main__; 'fastmcp' is a package and cannot be directly executed`
- The CLI tool wasn't properly installed or didn't work as expected

**Why it failed:**
- It seems the `fastmcp` package doesn't provide a command-line interface as we expected
- Trying to run it as a module (`python -m fastmcp`) failed

### Approach 5: Python Unbuffered Mode

**What we did:**
- Tried using Python's unbuffered mode (`-u` flag)
- This can help with stdio communication issues

**Configuration:**
```json
"calculator-mcp": {
  "command": "bash",
  "args": [
    "-c",
    "cd /path/to/calculator-mcp && /path/to/venv/bin/python -u -m fastmcp run calculator_mcp_first_approach.py:mcp"
  ]
}
```

**Error:**
- Same module import error
- Unbuffered mode didn't solve the fundamental issue

### Approach 6: Direct Script with Explicit Stdio (Final Solution - calculator_mcp.py)

**What we did:**
- Created a simplified script with explicit stdio transport
- Added logging to troubleshoot issues
- Explicitly set `transport="stdio"` in `mcp.run()`
- Configured Cursor to run Python directly on this script (no shell, no FastMCP CLI)

**Code:**
```python
# Force the stdio transport explicitly
mcp.run(transport="stdio")
```

**Configuration:**
```json
"calculator-mcp": {
  "command": "/path/to/venv/bin/python",
  "args": ["/path/to/calculator-mcp/calculator_mcp.py"]
}
```

**Result:**
- Success! The calculator tool appeared in Cursor and worked correctly
- We could perform calculations directly within Cursor using the MCP interface

### Key Lessons Learned

1. **Protocol matters**: Cursor's MCP system expects servers that communicate via stdio or SSE protocols, not regular HTTP APIs.

2. **Direct execution is best**: When configuring a Python MCP server for Cursor:
   - Avoid shell scripts or complex command chains
   - Run Python directly on your script
   - Use absolute paths to avoid directory issues

3. **Be explicit**: Don't rely on defaults - explicitly set `transport="stdio"` in your `mcp.run()` call.

4. **Simplify your setup**: The simpler your script, the fewer points of failure. Our final solution worked because:
   - It had minimal dependencies
   - It explicitly set the transport mode
   - It had direct Python execution without shell wrappers
   - It included error logging for troubleshooting

5. **Debug with logs**: When troubleshooting, add extensive logging to a file - this helps identify where things are breaking.

These lessons should help anyone trying to develop custom MCP servers for Cursor, especially when using Python and FastMCP.

## Deploying to Fly.io

This MCP server can be deployed to Fly.io using Docker.

### Prerequisites

1.  **Install `flyctl` CLI**: Follow instructions at [https://fly.io/docs/hands-on/install-flyctl/](https://fly.io/docs/hands-on/install-flyctl/).
2.  **Sign up for Fly.io**: Create an account at [https://fly.io/](https://fly.io/).
3.  **Login to Fly.io**: Run `flyctl auth login` in your terminal.

### Initial Setup (One-Time)

1.  **Launch the App on Fly.io (Manual First Time Step)**:
    *   Navigate to your project directory in the terminal.
    *   Run `flyctl launch`.
    *   You will be prompted for an **app name**. Choose a unique name (e.g., `yourname-calculator-mcp`) and note it down. This name will be part of your public URL (e.g., `yourname-calculator-mcp.fly.dev`).
    *   It will ask if you want to create a `fly.toml`. Say **No** (or let it create one and then replace its contents with the `fly.toml` in this repository, making sure to update the `app` name).
    *   It may ask if you want to deploy immediately. You can choose yes or no.
    *   This step registers your app with Fly.io and is crucial for subsequent automated deployments.

2.  **Update `fly.toml`**: Ensure the `app` name in your local `fly.toml` file matches the unique app name you selected during `flyctl launch`.

3.  **Create a Fly.io API Token for GitHub Actions**:
    *   Run the following command, replacing `YOUR_APP_NAME_HERE` with the app name you chose:
        ```bash
        flyctl tokens create deploy -a YOUR_APP_NAME_HERE
        ```
    *   Copy the generated API token.

4.  **Add the API Token to GitHub Secrets**:
    *   In your GitHub repository, go to "Settings" > "Secrets and variables" > "Actions".
    *   Click "New repository secret".
    *   Name the secret `FLY_API_TOKEN`.
    *   Paste the API token you copied into the "Secret" field.

### Deployment

*   **Automatic Deployment**: Pushing to the `main` branch (or your default branch as configured in `.github/workflows/fly-deploy.yml`) will automatically trigger a deployment via GitHub Actions.
*   **Manual Deployment**: You can deploy manually from your local machine using:
    ```bash
    flyctl deploy
    ```

### After Deployment

Your MCP server will be available at `https://YOUR_APP_NAME_HERE.fly.dev`.

### Connecting to Your Remote MCP Server from Cursor

1.  Configure Cursor to connect to your remote MCP server by adding this to `.cursor/mcp.json`:
    ```json
    "calculator-mcp": {
      "remote": true,
      "url": "https://YOUR_APP_NAME_HERE.fly.dev"
    }
    ```
    Replace `YOUR_APP_NAME_HERE.fly.dev` with your actual Fly.io app URL.

2.  Restart Cursor and connect to the `calculator-mcp` server from the MCP Servers section.

### Local Development

To run the server locally for development (e.g., on port 8080):

1.  Ensure you have Python and pip installed.
2.  Install dependencies: `pip install -r requirements.txt`
3.  Run the Uvicorn server directly:
    ```bash
    uvicorn calculator_mcp_fly:mcp.app --host 0.0.0.0 --port 8080 --reload
    ```
    The `--reload` flag will automatically restart the server when code changes are detected.
    You can then access it at `http://localhost:8080`.

// ... (Remove previous Cloudflare deployment sections or comment them out) ...

// ... existing code ... 