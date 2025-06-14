import {
  VibeKitConfig,
  CodexConfig,
  CodexResponse,
  CodexStreamCallbacks,
  ClaudeConfig,
  ClaudeResponse,
  ClaudeStreamCallbacks,
  Conversation,
  SandboxConfig,
} from "../types";
import { CodexAgent } from "../agents/codex";
import { ClaudeAgent } from "../agents/claude";
import { BaseAgent, AgentResponse as BaseAgentResponse } from "../agents/base";
import { TelemetryService } from "../services/telemetry";
import { createSandboxConfigFromEnvironment } from "../services/sandbox";

export type AgentResponse = CodexResponse | ClaudeResponse | { code: string };

// Unified streaming callback interface
export interface VibeKitStreamCallbacks {
  onUpdate?: (message: string) => void;
  onError?: (error: string) => void;
}

// Pull request response interface
export interface PullRequestResponse {
  html_url: string;
  number: number;
  branchName: string;
  commitSha?: string;
}

export class VibeKit {
  private agent: BaseAgent;
  private setup: VibeKitConfig;
  private telemetryService?: TelemetryService;

  constructor(setup: VibeKitConfig) {
    this.setup = setup;

    // Initialize telemetry service if enabled
    if (setup.telemetry?.isEnabled) {
      this.telemetryService = new TelemetryService(
        setup.telemetry,
        setup.sessionId
      );
    }

    // Initialize the appropriate agent
    this.agent = this.createAgent(setup);
  }

  private createAgent(setup: VibeKitConfig): BaseAgent {
    // Create sandbox configuration from the environment
    const sandboxConfig = createSandboxConfigFromEnvironment(
      setup.environment,
      setup.agent.type
    );

    if (setup.agent.type === "codex") {
      const codexConfig: CodexConfig = {
        providerApiKey: setup.agent.model.apiKey,
        provider: setup.agent.model.provider,
        githubToken: setup.github?.token,
        repoUrl: setup.github?.repository,
        // Keep backward compatibility for E2B-specific configs
        e2bApiKey: sandboxConfig.type === "e2b" ? sandboxConfig.apiKey : "",
        e2bTemplateId: sandboxConfig.templateId,
        model: setup.agent.model.name,
        sandboxId: setup.sessionId,
        telemetry: setup.telemetry,
        // Add new sandbox config
        sandboxConfig,
      };
      return new CodexAgent(codexConfig);
    } else if (setup.agent.type === "claude") {
      const claudeConfig: ClaudeConfig = {
        providerApiKey: setup.agent.model.apiKey,
        provider: setup.agent.model.provider,
        githubToken: setup.github?.token,
        repoUrl: setup.github?.repository,
        // Keep backward compatibility for E2B-specific configs
        e2bApiKey: sandboxConfig.type === "e2b" ? sandboxConfig.apiKey : "",
        e2bTemplateId: sandboxConfig.templateId,
        model: setup.agent.model.name,
        sandboxId: setup.sessionId,
        telemetry: setup.telemetry,
        // Add new sandbox config
        sandboxConfig,
      };
      return new ClaudeAgent(claudeConfig);
    } else {
      throw new Error(`Unsupported agent type: ${setup.agent.type}`);
    }
  }

  private getDataType(data: string): string {
    try {
      const parsed = JSON.parse(data);
      return parsed.type || "unknown";
    } catch {
      return "stream_output";
    }
  }

  async generateCode({
    prompt,
    mode,
    branch,
    history,
    callbacks,
  }: {
    prompt: string;
    mode: "ask" | "code";
    branch?: string;
    history?: Conversation[];
    callbacks?: VibeKitStreamCallbacks;
  }): Promise<AgentResponse> {
    const agentType = this.setup.agent.type;

    // Track telemetry start
    await this.telemetryService?.trackStart(agentType, mode, prompt, {
      repoUrl: this.setup.github?.repository,
      model: this.setup.agent.model.name,
      hasHistory: !!history?.length,
    });

    if (callbacks) {
      // Wrap callbacks with telemetry tracking
      const wrappedCallbacks = {
        onUpdate: async (data: string) => {
          callbacks.onUpdate?.(data);
          await this.telemetryService?.trackStream(
            agentType,
            mode,
            prompt,
            data,
            undefined,
            this.setup.github?.repository,
            {
              dataType: this.getDataType(data),
            }
          );
        },
        onError: async (error: string) => {
          callbacks.onError?.(error);
          await this.telemetryService?.trackError(
            agentType,
            mode,
            prompt,
            error,
            {
              source: `${agentType}_agent`,
            }
          );
        },
      };

      try {
        const result = await this.agent.generateCode(
          prompt,
          mode,
          branch,
          history,
          wrappedCallbacks
        );

        await this.telemetryService?.trackEnd(
          agentType,
          mode,
          prompt,
          result.sandboxId,
          this.setup.github?.repository,
          {
            exitCode: result.exitCode,
            stdoutLength: result.stdout?.length || 0,
            stderrLength: result.stderr?.length || 0,
          }
        );

        return result;
      } catch (error) {
        const errorMessage = `${agentType} generation failed: ${
          error instanceof Error ? error.message : String(error)
        }`;

        await this.telemetryService?.trackError(
          agentType,
          mode,
          prompt,
          errorMessage,
          {
            errorType:
              error instanceof Error ? error.constructor.name : "UnknownError",
            source: "vibekit",
          }
        );

        throw error;
      }
    }

    // Non-streaming path
    try {
      const result = await this.agent.generateCode(
        prompt,
        mode,
        branch,
        history
      );

      await this.telemetryService?.trackEnd(
        agentType,
        mode,
        prompt,
        result.sandboxId,
        this.setup.github?.repository,
        {
          exitCode: result.exitCode,
          stdoutLength: result.stdout?.length || 0,
          stderrLength: result.stderr?.length || 0,
        }
      );

      return result;
    } catch (error) {
      const errorMessage = `${agentType} generation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;

      await this.telemetryService?.trackError(
        agentType,
        mode,
        prompt,
        errorMessage,
        {
          errorType:
            error instanceof Error ? error.constructor.name : "UnknownError",
          source: "vibekit",
        }
      );

      throw error;
    }
  }

  /**
   * Create a Pull Request after generating code changes.
   * This method is available for both Codex and Claude agents and automatically labels
   * the pull request with the agent name ('codex' or 'claude').
   *
   * @returns Promise<PullRequestResponse> - Contains the PR URL, number, branch name, and commit SHA
   * @throws Error if the agent is not supported or if PR creation fails
   */
  async createPullRequest(): Promise<PullRequestResponse> {
    return this.agent.createPullRequest();
  }

  async pushToBranch(branch?: string): Promise<void> {
    return this.agent.pushToBranch(branch);
  }

  /**
   * Kill the active sandbox.
   */
  async kill(): Promise<void> {
    return this.agent.killSandbox();
  }

  /**
   * Pause the active sandbox.
   */
  async pause(): Promise<void> {
    return this.agent.pauseSandbox();
  }

  /**
   * Resume the paused sandbox.
   */
  async resume(): Promise<void> {
    return this.agent.resumeSandbox();
  }

  /**
   * Get the current session ID from the sandbox.
   *
   * @returns Promise<string | null> - The sandbox session ID or null if not available
   */
  async getSession(): Promise<string | null> {
    return this.agent.getSession();
  }

  /**
   * Set the session ID for the sandbox.
   *
   * @param sessionId - The session ID to set
   */
  async setSession(sessionId: string): Promise<void> {
    return this.agent.setSession(sessionId);
  }
}
