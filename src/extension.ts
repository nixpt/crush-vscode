import * as vscode from 'vscode';
import { spawn } from 'child_process';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

/**
 * Shape of `crushc --message-format json`'s NDJSON records
 * (`crush-lang-sdk::theme::JsonDiagnostic`, one per stderr line).
 * `line`/`col` are 1-indexed (compiler convention) — converted to
 * VS Code's 0-indexed `Position` in `toVscodeDiagnostic`.
 *
 * NOTE: even on success, crushc's `--message-format json` mode still
 * prints a plain-text line ("crushc: no errors detected") to stderr —
 * it does not emit an empty NDJSON stream. Every stderr line must be
 * parsed defensively; a line that isn't valid JSON is not an error in
 * this integration, it's just not a diagnostic. Verified empirically
 * against a real crushc build, not assumed from source reading alone.
 *
 * This whole crushc-spawn path is now the FALLBACK, used only when
 * crush-lsp (https://github.com/nixpt/crush-lsp) isn't on PATH — see
 * `activate()`. When the language server is active, it provides real
 * diagnostics (via crush-frontend, not this NDJSON format) plus hover
 * and completions this fallback never had.
 */
interface CrushJsonDiagnostic {
    code: string;
    level: string;
    file: string | null;
    line: number | null;
    col: number | null;
    message: string;
    hint: string | null;
}

let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.LogOutputChannel;
let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('crush');
    context.subscriptions.push(diagnosticCollection);

    outputChannel = vscode.window.createOutputChannel('Crush', { log: true });
    context.subscriptions.push(outputChannel);

    const config = () => vscode.workspace.getConfiguration('crush');

    let lspActive = false;
    if (config().get<boolean>('languageServer.enable', true)) {
        lspActive = await tryStartLanguageClient(
            context,
            config().get<string>('languageServer.path', 'crush-lsp')
        );
    }

    if (!lspActive) {
        registerCrushcFallback(context, config);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('crush.checkFile', () => {
            if (lspActive) {
                void vscode.window.showInformationMessage(
                    'Diagnostics are live via crush-lsp — no manual check needed.'
                );
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                void lintDocument(editor.document);
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    diagnosticCollection?.dispose();
    await client?.stop();
}

/**
 * Try to start the crush-lsp language client. Returns false (without
 * throwing, without showing VS Code's own noisy server-crash UI) if the
 * binary isn't found or fails to initialize, so the caller can fall back
 * to the crushc-spawn path instead.
 */
async function tryStartLanguageClient(
    context: vscode.ExtensionContext,
    lspPath: string
): Promise<boolean> {
    const serverOptions: ServerOptions = {
        command: lspPath,
        transport: TransportKind.stdio
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'crush' }],
        outputChannel
    };

    client = new LanguageClient('crush-lsp', 'Crush Language Server', serverOptions, clientOptions);

    try {
        await client.start();
    } catch (err) {
        outputChannel.appendLine(
            `crush-lsp not available at '${lspPath}' (${err}) — falling back to crushc-spawn diagnostics.`
        );
        client = undefined;
        return false;
    }

    context.subscriptions.push({ dispose: () => void client?.stop() });
    outputChannel.appendLine(`crush-lsp started (${lspPath}).`);
    return true;
}

function registerCrushcFallback(
    context: vscode.ExtensionContext,
    config: () => vscode.WorkspaceConfiguration
): void {
    const runDiagnostics = (document: vscode.TextDocument) => {
        if (document.languageId !== 'crush') {
            return;
        }
        if (!config().get<boolean>('diagnostics.enable', true)) {
            diagnosticCollection.delete(document.uri);
            return;
        }
        void lintDocument(document);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(runDiagnostics),
        vscode.workspace.onDidSaveTextDocument(runDiagnostics)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (config().get<boolean>('diagnostics.onChange', false)) {
                runDiagnostics(e.document);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            diagnosticCollection.delete(document.uri);
        })
    );

    // Lint whatever's already open when the extension activates.
    vscode.workspace.textDocuments.forEach(runDiagnostics);
}

async function lintDocument(document: vscode.TextDocument): Promise<void> {
    const crushcPath = vscode.workspace
        .getConfiguration('crush')
        .get<string>('crushcPath', 'crushc');

    let stderr: string;
    try {
        stderr = await runCrushc(crushcPath, document.uri.fsPath);
    } catch (err) {
        // crushc not found / failed to spawn at all — surface once in the
        // output channel, not as a per-file diagnostic (it isn't about
        // this file, it's about the tool not being reachable).
        outputChannel.appendLine(`crushc spawn failed: ${err}`);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    for (const line of stderr.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        let parsed: CrushJsonDiagnostic;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            // Not every stderr line is JSON — crushc's own "no errors
            // detected" success message is plain text even in
            // --message-format json mode. Not a parse failure worth
            // logging, just not a diagnostic.
            continue;
        }
        if (typeof parsed.message !== 'string' || typeof parsed.level !== 'string') {
            continue;
        }
        diagnostics.push(toVscodeDiagnostic(parsed));
    }

    diagnosticCollection.set(document.uri, diagnostics);
}

function toVscodeDiagnostic(d: CrushJsonDiagnostic): vscode.Diagnostic {
    // 1-indexed (compiler) -> 0-indexed (VS Code). Missing line/col
    // (the semantic analyzer doesn't attach source ranges yet — see
    // JsonDiagnostic::type_error's doc comment) falls back to the start
    // of the file rather than crashing on a null position.
    const line = Math.max(0, (d.line ?? 1) - 1);
    const col = Math.max(0, (d.col ?? 1) - 1);
    const range = new vscode.Range(line, col, line, col + 1);

    const severity =
        d.level === 'error'
            ? vscode.DiagnosticSeverity.Error
            : d.level === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;

    const message = d.hint ? `${d.message} (${d.hint})` : d.message;
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = 'crushc';
    diagnostic.code = d.code;
    return diagnostic;
}

function runCrushc(crushcPath: string, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(crushcPath, [filePath, '--message-format', 'json', '--check']);
        let stderr = '';
        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', (err) => {
            // ENOENT etc. — crushc isn't on PATH / configured path is wrong.
            reject(err);
        });
        proc.on('close', () => {
            // crushc exits 1 on a real compile error — that is success
            // from THIS function's point of view (we got diagnostics to
            // parse), not a rejection. Only a spawn failure above rejects.
            resolve(stderr);
        });
    });
}
