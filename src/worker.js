
const path = require(`path`);
const vscode = require(`vscode`);

const { instance } = vscode.extensions.getExtension(`halcyontechltd.code-for-ibmi`).exports;
const Configuration = require(`./configuration`);

const { registerColumnAssist } = require(`./columnAssist`);

const Declaration = require(`./models/declaration`);
const Cache = require(`./models/cache`);
const possibleTags = require(`./models/tags`);

const Linter = require(`./linter`);
const oneLineTriggers = require(`./models/oneLineTriggers`);

const lintFile = {
  member: `vscode,rpglint`,
  streamfile: `.vscode/rpglint.json`
};

module.exports = class {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.linterDiagnostics = vscode.languages.createDiagnosticCollection(`Lint`);

    /** @type {{[path: string]: string[]}} */
    this.copyBooks = {};

    /** @type {{[path: string]: Cache}} */
    this.parsedCache = {};

    /** @type {{[spfPath: string]: object}} */
    this.linterRules = {};

    registerColumnAssist(context);

    context.subscriptions.push(
      this.linterDiagnostics,

      vscode.commands.registerCommand(`vscode-rpgle.rpgleOpenInclude`, async => {
        if (Configuration.get(`rpgleContentAssistEnabled`)) {
          const editor = vscode.window.activeTextEditor;
          
          if (editor) {
            const document = editor.document;
            const position = editor.selection.active;
            if (document.languageId === `rpgle`) {
              const linePieces = document.lineAt(position.line).text.trim().split(` `);
              if ([`/COPY`, `/INCLUDE`].includes(linePieces[0].toUpperCase())) {
                const {finishedPath, type} = this.getPathInfo(document.uri, linePieces[1]);

                switch (type) {
                case `member`:
                  vscode.commands.executeCommand(`code-for-ibmi.openEditable`, `${finishedPath.substr(1)}.rpgle`);
                  break;

                case `streamfile`:
                  vscode.commands.executeCommand(`code-for-ibmi.openEditable`, finishedPath);
                  break;
                }
              }
            }
          }
        }
      }),

      vscode.workspace.onDidChangeTextDocument(async editor => {
        if (editor) {
          const document = editor.document;
          if (document.languageId === `rpgle`) {
            if (Configuration.get(`rpgleLinterSupportEnabled`)) {
              if (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`) {
                const text = document.getText();
                this.parsedCache[document.uri.path] = undefined;
                this.getDocs(document.uri, text).then(docs => {
                  this.refreshDiagnostics(document, docs);
                });
              }
            }
          }
        }
      }),

      vscode.languages.registerCodeActionsProvider(`rpgle`, {
        provideCodeActions: async (document, range) => {
          if (Configuration.get(`rpgleLinterSupportEnabled`)) {

            /** @type {vscode.CodeAction[]} */
            let actions = [];

            /** @type {vscode.CodeAction} */
            let action;

            const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
            const text = document.getText();
            if (isFree) {
              const options = this.getLinterOptions(document.uri);
              const docs = await this.getDocs(document.uri);

              const detail = Linter.getErrors(text, {
                indent: Number(vscode.window.activeTextEditor.options.tabSize),
                ...options
              }, docs);

              const fixErrors = detail.errors.filter(error => error.range.intersection(range) );

              if (fixErrors.length > 0) {
                let errorRange;
                fixErrors.forEach(error => {
                  errorRange = this.calculateOffset(document, error);

                  switch (error.type) {
                  case `UppercaseConstants`:
                    action = new vscode.CodeAction(`Convert constant name to uppercase`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(document.uri, errorRange, error.newValue);
                    actions.push(action);
                    break;
  
                  case `ForceOptionalParens`:
                    action = new vscode.CodeAction(`Add brackets around expression`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.insert(document.uri, errorRange.end, `)`);
                    action.edit.insert(document.uri, errorRange.start, `(`);
                    actions.push(action);
                    break;
  
                  case `UselessOperationCheck`:
                    action = new vscode.CodeAction(`Remove operation code`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.delete(document.uri, errorRange);
                    actions.push(action);
                    break;
  
                  case `SpecificCasing`:
                  case `IncorrectVariableCase`:
                    action = new vscode.CodeAction(`Correct casing to '${error.newValue}'`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(document.uri, errorRange, error.newValue);
                    actions.push(action);
                    break;

                  case `RequiresProcedureDescription`:
                    action = new vscode.CodeAction(`Add title and description`, vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.insert(document.uri, errorRange.start, `///\n// Title\n// Description\n///\n`);
                    actions.push(action);
                    break;
                  }
                });
              }

              console.log(actions);
            }
          
            return actions;
          }
        }
      }),

      vscode.languages.registerHoverProvider({language: `rpgle`}, {
        provideHover: async (document, position, token) => {
          if (Configuration.get(`rpgleContentAssistEnabled`)) {
            const text = document.getText();
            const doc = await this.getDocs(document.uri, text);
            const range = document.getWordRangeAtPosition(position);
            const word = document.getText(range).toUpperCase();

            const procedure = doc.procedures.find(proc => proc.name.toUpperCase() === word);

            if (procedure) {
              let markdown = ``;
              let retrunValue = procedure.keywords.filter(keyword => keyword !== `EXTPROC`);
              if (retrunValue.length === 0) retrunValue = [`void`];

              const returnTag = procedure.tags.find(tag => tag.tag === `return`);
              const deprecatedTag = procedure.tags.find(tag => tag.tag === `deprecated`);

              // Deprecated notice
              if (deprecatedTag) {
                markdown += `**Deprecated:** ${deprecatedTag.content}\n\n`;
              }

              // Formatted code
              markdown += `\`\`\`vb\n${procedure.name}(`;

              if (procedure.subItems.length > 0) {
                markdown += `\n  ${procedure.subItems.map(parm => `${parm.name}: ${parm.keywords.join(` `)}`).join(`,\n  `)}\n`;
              }

              markdown += `): ${retrunValue.join(` `)}\n\`\`\` \n`;

              // Description
              if (procedure.description)
                markdown += `${procedure.description}\n\n`;

              // Params
              markdown += procedure.subItems.map(parm => `*@param* \`${parm.name.replace(new RegExp(`\\*`, `g`), `\\*`)}\` ${parm.description}`).join(`\n\n`);

              // Return value
              if (returnTag) {
                markdown += `\n\n*@returns* ${returnTag.content}`;
              }

              if (procedure.position) {
                markdown += `\n\n*@file* \`${procedure.position.path}:${procedure.position.line+1}\``;
              }

              return new vscode.Hover(
                new vscode.MarkdownString(
                  markdown
                )
              );
            }

            const linePieces = document.lineAt(position.line).text.trim().split(` `);
            if ([`/COPY`, `/INCLUDE`].includes(linePieces[0].toUpperCase())) {
              const {type, memberPath, finishedPath} = this.getPathInfo(document.uri, linePieces[1]);

              return new vscode.Hover(
                new vscode.MarkdownString(
                  `\`'${finishedPath}'\` (${type})`
                )
              )
            }
          }

          return null;
        }
      }),

      vscode.languages.registerDocumentSymbolProvider({ language: `rpgle` }, 
        {
          provideDocumentSymbols: async (document, token) => {
            if (Configuration.get(`rpgleContentAssistEnabled`)) {
              const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
              
              const text = document.getText();
              if (isFree) {
                const doc = await this.getDocs(document.uri, text);

                const currentPath = document.uri.path;

                /** @type vscode.SymbolInformation[] */
                let currentDefs = [];

                currentDefs.push(
                  ...[
                    ...doc.procedures.filter(proc => proc.position && proc.position.path === currentPath),
                    ...doc.subroutines.filter(sub => sub.position && sub.position.path === currentPath),
                  ].map(def => new vscode.SymbolInformation(
                    def.name,
                    vscode.SymbolKind.Function,
                    new vscode.Range(def.position.line, 0, def.position.line, 0),
                    document.uri
                  ))
                );

                currentDefs.push(
                  ...doc.variables
                    .filter(variable => variable.position && variable.position.path === currentPath)
                    .map(def => new vscode.SymbolInformation(
                      def.name,
                      vscode.SymbolKind.Variable,
                      new vscode.Range(def.position.line, 0, def.position.line, 0),
                      document.uri
                    ))
                );

                currentDefs.push(
                  ...doc.structs
                    .filter(struct => struct.position && struct.position.path === currentPath)
                    .map(def => new vscode.SymbolInformation(
                      def.name,
                      vscode.SymbolKind.Struct,
                      new vscode.Range(def.position.line, 0, def.position.line, 0),
                      document.uri
                    ))
                );

                currentDefs.push(
                  ...doc.constants
                    .filter(constant => constant.position && constant.position.path === currentPath)
                    .map(def => new vscode.SymbolInformation(
                      def.name,
                      vscode.SymbolKind.Constant,
                      new vscode.Range(def.position.line, 0, def.position.line, 0),
                      document.uri
                    ))
                );

                return currentDefs;
              }
            }

            return [];
          }
        }),

      vscode.languages.registerDefinitionProvider({ language: `rpgle` }, {
        provideDefinition: async (document, position, token) => {
          if (Configuration.get(`rpgleContentAssistEnabled`)) {
            const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
            const doc = await this.getDocs(document.uri);
            const range = document.getWordRangeAtPosition(position);
            const word = document.getText(range).toUpperCase();

            if (doc) {
              const types = Object.keys(doc);
              const type = types.find(type => doc[type].find(def => def.name.toUpperCase() === word));
              if (doc[type]) {
                const def = doc[type].find(def => def.name.toUpperCase() === word);
                if (def) {
                  let {finishedPath, type} = this.getPathInfo(document.uri, def.position.path);
                  if (type === `member`) {
                    finishedPath = `${finishedPath}.rpgle`;
                  }

                  return new vscode.Location(
                    vscode.Uri.parse(finishedPath).with({scheme: type, path: finishedPath}),
                    new vscode.Range(def.position.line, 0, def.position.line, 0)
                  );
                }
              }
            }
          }
        }}),

      vscode.languages.registerCompletionItemProvider({language: `rpgle`, }, {
        provideCompletionItems: async (document, position) => {
          if (Configuration.get(`rpgleContentAssistEnabled`)) {
            const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
            const text = document.getText();
            if (isFree) {
              const currentLine = document.getText(new vscode.Range(position.line, 0, position.line, position.character));
              const doc = await this.getDocs(document.uri, text);

              /** @type vscode.CompletionItem[] */
              let items = [];
              let item;

              if (currentLine.startsWith(`//`)) {
                for (const tag in possibleTags) {
                  item = new vscode.CompletionItem(`@${tag}`, vscode.CompletionItemKind.Property);
                  item.insertText = new vscode.SnippetString(`@${tag} $0`);
                  item.detail = possibleTags[tag];
                  items.push(item);
                }

              } else {
                for (const procedure of doc.procedures) {
                  item = new vscode.CompletionItem(`${procedure.name}`, vscode.CompletionItemKind.Function);
                  item.insertText = new vscode.SnippetString(`${procedure.name}(${procedure.subItems.map((parm, index) => `\${${index+1}:${parm.name}}`).join(`:`)})\$0`)
                  item.detail = procedure.keywords.join(` `);
                  item.documentation = procedure.description;
                  items.push(item);
                }

                for (const subroutine of doc.subroutines) {
                  item = new vscode.CompletionItem(`${subroutine.name}`, vscode.CompletionItemKind.Function);
                  item.insertText = new vscode.SnippetString(`${subroutine.name}\$0`);
                  item.documentation = subroutine.description;
                  items.push(item);
                }

                for (const variable of doc.variables) {
                  item = new vscode.CompletionItem(`${variable.name}`, vscode.CompletionItemKind.Variable);
                  item.insertText = new vscode.SnippetString(`${variable.name}\$0`);
                  item.detail = variable.keywords.join(` `);
                  item.documentation = variable.description;
                  items.push(item);
                }

                for (const struct of doc.structs) {
                  item = new vscode.CompletionItem(`${struct.name}`, vscode.CompletionItemKind.Struct);
                  item.insertText = new vscode.SnippetString(`${struct.name}\$0`);
                  item.detail = struct.keywords.join(` `);
                  item.documentation = struct.description;
                  items.push(item);
                }

                for (const constant of doc.constants) {
                  item = new vscode.CompletionItem(`${constant.name}`, vscode.CompletionItemKind.Constant);
                  item.insertText = new vscode.SnippetString(`${constant.name}\$0`);
                  item.detail = constant.keywords.join(` `);
                  item.documentation = constant.description;
                  items.push(item);
                }
              }

              return items;
            }
          }
        }
      }),

      vscode.window.onDidChangeActiveTextEditor(async (e) => {
        if (e && e.document) {
          if (e.document.languageId === `rpgle`) {
            const document = e.document;

            const text = document.getText();
            const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
            if (isFree) {
              this.updateCopybookCache(document.uri, text);

              this.getDocs(document.uri, text).then(doc => {
                this.refreshDiagnostics(document, doc);
              });
            }
          }
        }
      }),

      vscode.workspace.onDidSaveTextDocument((document) => {
        if (Configuration.get(`rpgleContentAssistEnabled`)) {
          const workingUri = document.uri;
          const {finishedPath} = this.getPathInfo(workingUri, path.basename(workingUri.path));
          const text = document.getText();
          const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);

          if (this.copyBooks[finishedPath]) {
            //Update stored copy book
            const lines = text.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);
            this.copyBooks[finishedPath] = lines;

            // The user usually switches tabs very quickly, so we trigger this event too.
            if (vscode.window.activeTextEditor) {
              if (workingUri.path !== vscode.window.activeTextEditor.document.uri.path) {
                this.getDocs(workingUri).then(docs => {
                  this.refreshDiagnostics(vscode.window.activeTextEditor.document, docs);
                });
              }
            }
          }
          else if (document.languageId === `rpgle`) {
            //Else fetch new info from source being edited
            if (isFree) {
              this.updateCopybookCache(workingUri, text).then(() => {});
            }
          }
        }
      }),

      vscode.workspace.onDidOpenTextDocument((document) => {
        let text;
        switch (document.languageId) {
        case `rpgle`:
          const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
          text = document.getText();
          if (Configuration.get(`rpgleContentAssistEnabled`)) {
            if (isFree) {
              this.updateCopybookCache(document.uri, text);
            }
          }
  
          if (Configuration.get(`rpgleLinterSupportEnabled`)) {
            this.getLinterFile(document).then(file => {
              this.getDocs(document.uri, text).then(docs => {
                this.refreshDiagnostics(document, docs);
              });
            });
          }

          break;
        
        // We need to update our copy of the linter configuration
        case `json`:
          text = document.getText();
          if (Configuration.get(`rpgleLinterSupportEnabled`)) {
            let upperPath;
            switch (document.uri.scheme) {
            case `member`:
              upperPath = document.uri.path.toUpperCase().substring(0, document.uri.path.length - 5); //without the extension
              break;
            case `streamfile`:
              upperPath = document.uri.path.toUpperCase();
              break;
            }

            if (upperPath.includes(`RPGLINT`)) {
              if (!this.copyBooks[upperPath])
                this.copyBooks[upperPath] = [text];
            }
          }
          break;
        }
      })
    )
    
  }

  /**
   * @param {vscode.Uri} workingUri Path being worked with
   * @param {string} getPath IFS or member path to fetch (in the format of an RPGLE copybook)
   */
  getPathInfo(workingUri, getPath) {
    const config = instance.getConfig();

    /** @type {string} */
    let finishedPath = undefined;

    /** @type {string[]} */
    let memberPath = undefined;

    /** @type {"streamfile"|"member"|undefined} */
    let type = undefined;

    if (workingUri.scheme === `streamfile`) {
      type = `streamfile`;
      //Fetch IFS

      if (getPath.startsWith(`'`)) getPath = getPath.substring(1);
      if (getPath.endsWith(`'`)) getPath = getPath.substring(0, getPath.length - 1);

      if (getPath.startsWith(`/`)) {
        //Get from root
        finishedPath = getPath;
      } 

      else {
        finishedPath = path.posix.join(config.homeDirectory, getPath);
      }

    } else {
      //Fetch member
      const getLib = getPath.split(`/`);
      const getMember = getLib[getLib.length-1].split(`,`);
      const workingPath = workingUri.path.split(`/`);
      memberPath = [undefined, undefined, `QRPGLEREF`, undefined];

      if (workingPath.length === 4) { //ASP not included
        memberPath[1] = workingPath[1];
        memberPath[2] = workingPath[2];
      } else {
        memberPath[0] = workingPath[1];
        memberPath[1] = workingPath[2];
        memberPath[2] = workingPath[3];
      }

      switch (getMember.length) {
      case 1:
        memberPath[3] = getMember[0];
        break;
      case 2:
        memberPath[2] = getMember[0];
        memberPath[3] = getMember[1];
      }

      if (getLib.length === 2) {
        memberPath[1] = getLib[0];
      }

      if (memberPath[3].includes(`.`)) {
        memberPath[3] = memberPath[3].substr(0, memberPath[3].lastIndexOf(`.`));
      }

      finishedPath = memberPath.join(`/`);

      if (workingPath.length === 5) {
        finishedPath = `/${finishedPath}`;
      }

      type = `member`;
    }

    finishedPath = finishedPath.toUpperCase();

    return {type, memberPath, finishedPath};
  }

  /**
   * @param {vscode.Uri} workingUri Path being worked with
   * @param {string} getPath IFS or member path to fetch
   * @returns {Promise<string[]>}
   */
  async getContent(workingUri, getPath) {
    const contentApi = instance.getContent();

    let content;
    let lines = undefined;

    let {type, memberPath, finishedPath} = this.getPathInfo(workingUri, getPath);

    try {
      switch (type) {
      case `member`:
        if (this.copyBooks[finishedPath]) {
          lines = this.copyBooks[finishedPath];
        } else {  
          content = await contentApi.downloadMemberContent(memberPath[0], memberPath[1], memberPath[2], memberPath[3]);
          lines = content.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);
          this.copyBooks[finishedPath] = lines;
        }
        break;

      case `streamfile`:
        if (this.copyBooks[finishedPath]) {
          lines = this.copyBooks[finishedPath];
        } else {
          content = await contentApi.downloadStreamfile(finishedPath);
          lines = content.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);
          this.copyBooks[finishedPath] = lines;
        }
        break;
      }
    } catch (e) {
      lines = [];
    }

    return lines;
  }

  /**
   * @param {vscode.Uri} workingUri
   * @param {string} content 
   */
  async updateCopybookCache(workingUri, content) {
    if (this.parsedCache[workingUri.path]) {
      this.parsedCache[workingUri.path] = undefined; //Clear parsed data

      let baseLines = content.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);

      //First loop is for copy/include statements
      for (let i = baseLines.length - 1; i >= 0; i--) {
        const line = baseLines[i].trim(); //Paths are case insensitive so it's okay
        if (line === ``) continue;

        const pieces = line.split(` `).filter(piece => piece !== ``);

        if ([`/COPY`, `/INCLUDE`].includes(pieces[0].toUpperCase())) {
          await this.getContent(workingUri, pieces[1]);
        }
      }
    }
  }

  /**
   * @param {vscode.Uri} workingUri
   * @param {string} [content] 
   * @param {boolean} [withIncludes] To make sure include statements are parsed
   * @returns {Promise<Cache|null>}
   */
  async getDocs(workingUri, content, withIncludes = true) {
    if (this.parsedCache[workingUri.path]) {
      return this.parsedCache[workingUri.path];
    };

    if (!content) return null;

    let files = {};
    let baseLines = content.replace(new RegExp(`\\\r`, `g`), ``).split(`\n`);

    let currentTitle = undefined, currentDescription = [];
    /** @type {{tag: string, content: string}[]} */
    let currentTags = [];

    let currentItem, currentSub;

    let resetDefinition = false; //Set to true when you're done defining a new item
    let docs = false; // If section is for ILEDocs
    let lineNumber, parts, partsLower, pieces;

    const constants = [];
    const variables = [];
    const structs = [];
    const procedures = [];
    const subroutines = [];

    files[workingUri.path] = baseLines;

    if (withIncludes) {
    //First loop is for copy/include statements
      for (let i = baseLines.length - 1; i >= 0; i--) {
        let line = baseLines[i].trim(); //Paths are case insensitive so it's okay
        if (line === ``) continue;

        pieces = line.split(` `).filter(piece => piece !== ``);

        if ([`/COPY`, `/INCLUDE`].includes(pieces[0].toUpperCase())) {
          files[pieces[1]] = (await this.getContent(workingUri, pieces[1]));
        }
      }
    }

    //Now the real work
    for (const file in files) {
      lineNumber = -1;
      for (let line of files[file]) {
        lineNumber += 1;

        line = line.trim();

        if (line === ``) continue;

        pieces = line.split(`;`);
        parts = pieces[0].toUpperCase().split(` `).filter(piece => piece !== ``);
        partsLower = pieces[0].split(` `).filter(piece => piece !== ``);

        switch (parts[0]) {
        case `DCL-C`:
          if (currentItem === undefined) {
            currentItem = new Declaration(`constant`);
            currentItem.name = partsLower[1];
            currentItem.keywords = parts.slice(2);
            currentItem.description = currentDescription.join(` `);

            currentItem.position = {
              path: file,
              line: lineNumber
            }

            constants.push(currentItem);
            resetDefinition = true;
          }
          break;

        case `DCL-S`:
          if (currentItem === undefined) {
            if (!parts.includes(`TEMPLATE`)) {
              currentItem = new Declaration(`variable`);
              currentItem.name = partsLower[1];
              currentItem.keywords = parts.slice(2);
              currentItem.description = currentDescription.join(` `);
              currentItem.tags = currentTags;

              currentItem.position = {
                path: file,
                line: lineNumber
              }

              variables.push(currentItem);
              resetDefinition = true;
            }
          }
          break;

        case `DCL-DS`:
          if (currentItem === undefined) {
            if (!parts.includes(`TEMPLATE`)) {
              currentItem = new Declaration(`struct`);
              currentItem.name = partsLower[1];
              currentItem.keywords = parts.slice(2);
              currentItem.description = currentDescription.join(` `);
              currentItem.tags = currentTags;

              currentItem.position = {
                path: file,
                line: lineNumber
              }

              // Does the keywords include a keyword that makes end-ds useless?
              if (currentItem.keywords.some(keyword => oneLineTriggers[`DCL-DS`].some(trigger => keyword.startsWith(trigger)))) {
                structs.push(currentItem);
                resetDefinition = true;
              }

              currentDescription = [];
            }
          }
          break;

        case `END-DS`:
          if (currentItem && currentItem.type === `struct`) {
            structs.push(currentItem);
            resetDefinition = true;
          }
          break;
        
        case `DCL-PR`:
          if (currentItem === undefined) {
            if (!procedures.find(proc => proc.name.toUpperCase() === parts[1])) {
              currentItem = new Declaration(`procedure`);
              currentItem.name = partsLower[1];
              currentItem.keywords = parts.slice(2);
              currentItem.description = currentDescription.join(` `);
              currentItem.tags = currentTags;

              currentItem.position = {
                path: file,
                line: lineNumber
              }

              currentItem.readParms = true;

              currentDescription = [];
            }
          }
          break;

        case `END-PR`:
          if (currentItem && currentItem.type === `procedure`) {
            procedures.push(currentItem);
            resetDefinition = true;
          }
          break;
        
        case `DCL-PROC`:
          //We can overwrite it.. it might have been a PR before.
          currentItem = procedures.find(proc => proc.name.toUpperCase() === parts[1]) || new Declaration(`procedure`);

          currentItem.name = partsLower[1];
          currentItem.keywords = parts.slice(2);
          currentItem.description = currentDescription.join(` `);
          currentItem.tags = currentTags;

          currentItem.position = {
            path: file,
            line: lineNumber
          }

          currentItem.readParms = false;

          currentDescription = [];
          break;

        case `DCL-PI`:
          if (currentItem) {
            currentItem.keywords = parts.slice(2);
            currentItem.readParms = true;

            currentDescription = [];
          }
          break;

        case `END-PI`:
          if (currentItem && currentItem.type === `procedure`) {
            currentItem.readParms = false;
          }
          break;

        case `END-PROC`:
          if (currentItem && currentItem.type === `procedure`) {
            procedures.push(currentItem);
            resetDefinition = true;
          }
          break;

        case `BEGSR`:
          if (!subroutines.find(sub => sub.name.toUpperCase() === parts[1])) {
            currentItem = new Declaration(`subroutine`);
            currentItem.name = partsLower[1];
            currentItem.description = currentDescription.join(` `);

            currentItem.position = {
              path: file,
              line: lineNumber
            }

            currentDescription = [];
          }
          break;
    
        case `ENDSR`:
          if (currentItem && currentItem.type === `subroutine`) {
            subroutines.push(currentItem);
            resetDefinition = true;
          }
          break;

        case `///`:
          docs = !docs;
          
          // When enabled
          if (docs === true) {
            currentTitle = undefined;
            currentDescription = [];
            currentTags = [];
          }
          break;

        default:
          if (line.startsWith(`//`)) {
            if (docs) {
              const content = line.substring(2).trim();
              if (content.length > 0) {
                if (content.startsWith(`@`)) {
                  const lineData = content.substring(1).split(` `);
                  currentTags.push({
                    tag: lineData[0],
                    content: lineData.slice(1).join(` `)
                  });
                } else {
                  if (currentTags.length > 0) {
                    currentTags[currentTags.length - 1].content += ` ${content}`;

                  } else {
                    if (currentTitle === undefined) {
                      currentTitle = content;
                    } else {
                      currentDescription.push(content);
                    }
                  }
                }
              }

            } else {
              //Do nothing because it's a regular comment
            }

          } else {
            if (currentItem && currentItem.type === `procedure`) {
              if (currentItem.readParms) {
                if (parts[0].startsWith(`DCL`))
                  parts.slice(1);

                currentSub = new Declaration(`subitem`);
                currentSub.name = (parts[0] === `*N` ? `parm${currentItem.subItems.length+1}` : partsLower[0]) ;
                currentSub.keywords = parts.slice(1);

                const paramTags = currentTags.filter(tag => tag.tag === `param`);
                const paramTag = paramTags.length > currentItem.subItems.length ? paramTags[currentItem.subItems.length] : undefined;
                if (paramTag) {
                  currentSub.description = paramTag.content;
                }

                currentItem.subItems.push(currentSub);
                currentSub = undefined;
              }
            }
          }
          break;
        }

        if (resetDefinition) {
          currentItem = undefined;
          currentTitle = undefined;
          currentDescription = [];
          currentTags = [];
          resetDefinition = false;
        }
      
      }
    }

    const parsedData = new Cache({
      procedures,
      structs,
      subroutines,
      variables,
      constants
    });

    this.parsedCache[workingUri.path] = parsedData;

    return parsedData;
  }

  /**
   * Returns relative linter configuration path
   * @param {vscode.Uri} uri 
   */
  getLintConfigPath(uri) {
    const lintPath = lintFile[uri.scheme];

    let resultPath;

    if (lintPath) {
      let {finishedPath, type} = this.getPathInfo(uri, lintPath);
      switch (type) {
      case `member`:
        return {path: `${finishedPath.substr(1)}.JSON`, type: `member`};
      case `streamfile`:
        return {path: finishedPath.toLowerCase(), type: `streamfile`};
      }
    }

    return null;
  }

  /**
   * @param {vscode.TextDocument} document 
   */
  getLinterFile(document) {
    // Used to fetch the linter settings
    // Will only download once.
    const lintPath = lintFile[document.uri.scheme];
    if (lintPath) {
      return this.getContent(document.uri, lintPath);
    }
  }

  getLinterOptions(workingUri) {
    let options = {};

    const localLintPath = lintFile[workingUri.scheme];
    if (localLintPath) {
      let {finishedPath} = this.getPathInfo(workingUri, localLintPath);

      if (this.copyBooks[finishedPath]) {
        const jsonString = this.copyBooks[finishedPath].join(``).trim();
        if (jsonString) {
          try {
            options = JSON.parse(jsonString);
            return options;
          } catch (e) {
            //vscode.window.showErrorMessage(`Failed to parse rpglint.json file at ${lintPath}.`);
          }
        }
      }
    }

    return options;
  }

  /** 
   * @param {vscode.TextDocument} document 
   * @param {Cache} [docs]
   * */
  async refreshDiagnostics(document, docs) {
    const isFree = (document.getText(new vscode.Range(0, 0, 0, 6)).toUpperCase() === `**FREE`);
    if (isFree) {
      const text = document.getText();

      /** @type {vscode.Diagnostic[]} */
      let indentDiags = [];

      /** @type {vscode.Diagnostic[]} */
      let generalDiags = [];

      const options = this.getLinterOptions(document.uri);

      const detail = Linter.getErrors(text, {
        indent: Number(vscode.window.activeTextEditor.options.tabSize),
        ...options
      }, docs);

      const indentErrors = detail.indentErrors;
      const errors = detail.errors;

      if (indentErrors.length > 0) {
        indentErrors.forEach(error => {
          const range = new vscode.Range(error.line, 0, error.line, error.currentIndent);

          indentDiags.push(new vscode.Diagnostic(
            range, 
            `Incorrect indentation. Expected ${error.expectedIndent}, got ${error.currentIndent}`, 
            vscode.DiagnosticSeverity.Warning
          ));
        });
      }

      if (errors.length > 0) {
        errors.forEach(error => {
          const range = this.calculateOffset(document, error);

          const diagnostic = new vscode.Diagnostic(
            range, 
            Linter.getErrorText(error.type), 
            vscode.DiagnosticSeverity.Warning
          );

          generalDiags.push(diagnostic);
        });
      }

      this.linterDiagnostics.set(document.uri, [...indentDiags, ...generalDiags]);
    }
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {{range: vscode.Range, offset?: {position: number, length: number}}} error 
   */
  calculateOffset(document, error) {
    const offset = error.offset;
    let range;

    if (offset) {
      const docOffsetStart = document.offsetAt(error.range.start) + offset.position;
      const docOffsetEnd = document.offsetAt(error.range.start) + offset.length;
      range = new vscode.Range(
        document.positionAt(docOffsetStart),
        document.positionAt(docOffsetEnd)
      );
    } else {
      range = error.range;
    }
    
    return range;
  }
}