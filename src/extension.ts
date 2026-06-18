import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isPubspecFile, readPackageLines, checkForUpdates, Dependency, CustomDiagnostic } from './analyze_dependencies';
import { MyCodeActionProvider } from './quick_fix';

const COMMAND_PREFIX = 'pubspec-dependency-inspector';
const execAsync = promisify(exec);

let customDiagnosticList: CustomDiagnostic[] = [];

function syncUpdateAllButton(
	updateAllStatusBarItem: vscode.StatusBarItem,
	diagnosticCollection: vscode.DiagnosticCollection
): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !isPubspecFile(editor.document.fileName)) {
		updateAllStatusBarItem.hide();
		return;
	}

	const hasUpdates = (diagnosticCollection.get(editor.document.uri) ?? []).some(
		(diagnostic) => diagnostic.code === 'updateDependency'
	);

	if (hasUpdates) {
		updateAllStatusBarItem.text = '$(refresh) Update all dependencies';
		updateAllStatusBarItem.show();
	} else {
		updateAllStatusBarItem.hide();
	}
}

function hideStatusBarActions(
	analyzeStatusBarItem: vscode.StatusBarItem,
	updateAllStatusBarItem: vscode.StatusBarItem
): void {
	analyzeStatusBarItem.hide();
	updateAllStatusBarItem.hide();
}

async function runAnalyze(
	diagnosticCollection: vscode.DiagnosticCollection,
	analyzeStatusBarItem: vscode.StatusBarItem,
	updateAllStatusBarItem: vscode.StatusBarItem,
	analyzingRef: { inProgress: boolean }
): Promise<void> {
	if (analyzingRef.inProgress) {
		return;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor) {
		return;
	}

	const document = activeEditor.document;
	const file = document.fileName.toString() ?? '';

	if (file === '' || !isPubspecFile(file)) {
		vscode.window.showInformationMessage('Not a pubspec.yaml file');
		analyzeStatusBarItem.text = '$(cross) Analyze failed!';
		analyzeStatusBarItem.show();
		setTimeout(() => analyzeStatusBarItem.hide(), 1000);
		return;
	}

	analyzingRef.inProgress = true;
	updateAllStatusBarItem.hide();
	analyzeStatusBarItem.text = '$(sync~spin) Analyzing dependencies...';
	analyzeStatusBarItem.show();

	try {
		let dependenciesList: Dependency[] = [];
		const dependencies = readPackageLines(file);

		if (dependencies.length > 0) {
			dependenciesList = await checkForUpdates(dependencies);
		}

		const diagnosticList: vscode.Diagnostic[] = [];
		customDiagnosticList = [];

		for (const dependency of dependenciesList) {
			if (!dependency.updateAvailable) {
				continue;
			}

			const range = new vscode.Range(
				document.positionAt(dependency.dependencyStartOffset),
				document.positionAt(dependency.dependencyEndOffset)
			);
			const diagnostic = new vscode.Diagnostic(
				range,
				`${dependency.name} has a update from ${dependency.currentVersion} -> ${dependency.latestVersion}`,
				vscode.DiagnosticSeverity.Warning
			);
			diagnostic.code = 'updateDependency';

			diagnosticList.push(diagnostic);
			customDiagnosticList.push({ diagnostic, dependency });
		}

		if (diagnosticList.length > 0) {
			diagnosticCollection.set(document.uri, diagnosticList);
			analyzeStatusBarItem.hide();
			syncUpdateAllButton(updateAllStatusBarItem, diagnosticCollection);
		} else {
			diagnosticCollection.delete(document.uri);
			updateAllStatusBarItem.hide();
			analyzeStatusBarItem.text = '$(check) Analyze completed!';
			analyzeStatusBarItem.show();
			setTimeout(() => analyzeStatusBarItem.hide(), 1000);
		}
	} finally {
		analyzingRef.inProgress = false;
	}
}

async function runFlutterPubUpgrade(pubspecPath: string): Promise<void> {
	const cwd = path.dirname(pubspecPath);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Running flutter pub upgrade...',
			cancellable: false,
		},
		async () => {
			try {
				await execAsync('flutter pub upgrade', { cwd, maxBuffer: 10 * 1024 * 1024 });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`flutter pub upgrade failed: ${message}`);
				throw error;
			}
		}
	);
}

export function activate(context: vscode.ExtensionContext) {
	const analyzingRef = { inProgress: false };

	const diagnosticCollection = vscode.languages.createDiagnosticCollection('myExtension');
	const analyzeStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	const updateAllStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		99
	);
	updateAllStatusBarItem.command = `${COMMAND_PREFIX}.updateAllDependencies`;
	updateAllStatusBarItem.tooltip = 'Update all outdated dependencies to their latest versions';

	context.subscriptions.push(
		diagnosticCollection,
		analyzeStatusBarItem,
		updateAllStatusBarItem,

		vscode.commands.registerCommand(`${COMMAND_PREFIX}.analyzeDependencies`, () =>
			runAnalyze(diagnosticCollection, analyzeStatusBarItem, updateAllStatusBarItem, analyzingRef)
		),

		vscode.commands.registerCommand(`${COMMAND_PREFIX}.updateDependency`, async (diagnostic: vscode.Diagnostic) => {
			const activeEditor = vscode.window.activeTextEditor;

			if (!activeEditor) {
				return;
			}

			const document = activeEditor.document;
			const file = document.fileName.toString() ?? '';

			if (file === '' || !isPubspecFile(file)) {
				return;
			}

			for (let i = 0; i < customDiagnosticList.length; i++) {
				if (diagnostic.message !== customDiagnosticList[i].diagnostic.message) {
					continue;
				}

				const dependency = customDiagnosticList[i].dependency;

				const edit = new vscode.WorkspaceEdit();
				const range = new vscode.Range(
					document.positionAt(dependency.currentVersionStartOffset),
					document.positionAt(dependency.currentVersionEndOffset)
				);
				edit.replace(document.uri, range, dependency.latestVersion!);
				await vscode.workspace.applyEdit(edit);

				const diagnosticList = diagnosticCollection.get(document.uri)?.map((d) => d);
				const diagnosticIndex = diagnosticList?.findIndex((d) => d === diagnostic);
				if (diagnosticList !== undefined && diagnosticIndex !== undefined) {
					diagnosticList.splice(diagnosticIndex, 1);
					customDiagnosticList.splice(i, 1);
					diagnosticCollection.set(document.uri, diagnosticList);
					syncUpdateAllButton(updateAllStatusBarItem, diagnosticCollection);
				}

				if (dependency.hasPrefix && diagnosticIndex !== undefined) {
					for (let index = diagnosticIndex; index < customDiagnosticList.length; index++) {
						const item = customDiagnosticList[index].dependency;

						item.dependencyStartOffset = item.dependencyStartOffset - 1;
						item.dependencyEndOffset = item.dependencyEndOffset - 1;
						item.currentVersionStartOffset = item.currentVersionStartOffset;
						item.currentVersionEndOffset = item.currentVersionEndOffset;
					}
				}

				const versionOffset = dependency.currentVersion.length - dependency.latestVersionOffset!;
				if (versionOffset !== 0 && diagnosticIndex !== undefined) {
					for (let index = diagnosticIndex; index < customDiagnosticList.length; index++) {
						const item = customDiagnosticList[index].dependency;

						item.dependencyStartOffset = item.dependencyStartOffset - versionOffset;
						item.dependencyEndOffset = item.dependencyEndOffset - versionOffset;
						item.currentVersionStartOffset = item.currentVersionStartOffset - versionOffset;
						item.currentVersionEndOffset = item.currentVersionEndOffset - versionOffset;
					}
				}
			}
		}),

		vscode.commands.registerCommand(`${COMMAND_PREFIX}.updateAllDependencies`, async () => {
			await runAnalyze(
				diagnosticCollection,
				analyzeStatusBarItem,
				updateAllStatusBarItem,
				analyzingRef
			);

			const activeEditor = vscode.window.activeTextEditor;

			if (!activeEditor) {
				return;
			}

			const document = activeEditor.document;
			const file = document.fileName.toString() ?? '';

			if (file === '' || !isPubspecFile(file)) {
				return;
			}

			const outdated = customDiagnosticList.filter((item) => item.dependency.latestVersion);
			if (outdated.length === 0) {
				return;
			}

			updateAllStatusBarItem.hide();
			analyzeStatusBarItem.text = '$(sync~spin) Updating dependencies...';
			analyzeStatusBarItem.show();

			const edit = new vscode.WorkspaceEdit();
			const sorted = [...outdated].sort(
				(a, b) =>
					b.dependency.currentVersionStartOffset -
					a.dependency.currentVersionStartOffset
			);

			for (const { dependency } of sorted) {
				const range = new vscode.Range(
					document.positionAt(dependency.currentVersionStartOffset),
					document.positionAt(dependency.currentVersionEndOffset)
				);
				edit.replace(document.uri, range, dependency.latestVersion!);
			}

			const applied = await vscode.workspace.applyEdit(edit);
			if (!applied) {
				analyzeStatusBarItem.hide();
				return;
			}

			if (document.isDirty) {
				await document.save();
			}

			try {
				await runFlutterPubUpgrade(file);
			} catch {
				await runAnalyze(
					diagnosticCollection,
					analyzeStatusBarItem,
					updateAllStatusBarItem,
					analyzingRef
				);
				return;
			}

			await runAnalyze(
				diagnosticCollection,
				analyzeStatusBarItem,
				updateAllStatusBarItem,
				analyzingRef
			);
		}),

		vscode.languages.registerCodeActionsProvider('yaml', new MyCodeActionProvider())
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
			if (isPubspecFile(document.fileName)) {
				void vscode.commands.executeCommand(`${COMMAND_PREFIX}.analyzeDependencies`);
			}
		})
	);

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
			if (editor !== undefined && isPubspecFile(editor.document.fileName)) {
				syncUpdateAllButton(updateAllStatusBarItem, diagnosticCollection);
				void vscode.commands.executeCommand(`${COMMAND_PREFIX}.analyzeDependencies`);
			} else {
				hideStatusBarActions(analyzeStatusBarItem, updateAllStatusBarItem);
			}
		})
	);
}

export function deactivate() {}
