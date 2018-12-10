import * as util from 'util';
import * as vs from 'vscode';
import * as sch from '../schema/base';
import { AbstractProvider, svcRequest } from './provider';
import { XMLElement } from '../types';

function attrSchDocs(sAttr: sch.Attribute)  {
    let s = '';
    s += `&nbsp;**@**${sAttr.name}${(sAttr.required ? '' : '?')} — \`${sAttr.type.name}\``;
    if (sAttr.documentation) {
        s += ' — ' + sAttr.documentation;
    }
    return s;
}

export class HoverProvider extends AbstractProvider implements vs.HoverProvider {
    @svcRequest(
        false,
        (document: vs.TextDocument, position: vs.Position) => {
            return {
                filename: document.uri.fsPath,
                position: {line: position.line, char: position.character},
            };
        },
        (r: vs.Hover) => typeof r
    )
    async provideHover(document: vs.TextDocument, position: vs.Position, token: vs.CancellationToken) {
        const sourceFile = await this.svcContext.syncVsDocument(document);

        const offset = document.offsetAt(position);
        const node = sourceFile.findNodeAt(offset);
        let hv: vs.Hover;

        if (node instanceof XMLElement && node.stype) {
            if (node.start <= offset && (node.start + node.tag.length + 1) > offset) {
                if (node.sdef) {
                    let contents = '';
                    contents += `**${node.sdef.name}** — [${node.sdef.type.name}]`;
                    if (node.sdef.label) {
                        contents += '\\\n' + node.sdef.label;
                    }
                    for (const sAttr of node.stype.attributes.values()) {
                        contents += '\n\n' + attrSchDocs(sAttr);
                    }
                    if (node.sdef.documentation) {
                        contents += '\n\n---\n\n' + node.sdef.documentation;
                    }
                    hv = new vs.Hover(contents);
                }
            }
            else {
                const attr = node.findAttributeAt(offset);
                if (attr) {
                    let scAttr = node.stype.attributes.get(attr.name.toLowerCase());
                    if (!scAttr) {
                        const indType = this.xray.matchIndeterminateAttr(node, attr.name);
                        if (indType) {
                            scAttr = {
                                name: indType.key.name,
                                type: indType.value,
                                required: true,
                            };
                        }
                    }

                    if (scAttr) {
                        if ((attr.start + attr.name.length) > offset) {
                            let contents = attrSchDocs(scAttr);
                            if (scAttr.type.kind === sch.SimpleTypeKind.Enumaration || scAttr.type.kind === sch.SimpleTypeKind.Flags) {
                                contents += '\n\n**Values / Flags**:\n\n';
                                for (const item of scAttr.type.emap.values()) {
                                    contents += `\`${item.name}\``;
                                    if (item.label) {
                                        contents += ` — ${item.label}`;
                                    }
                                    contents += '\\\n';
                                }
                            }
                            hv = new vs.Hover(
                                new vs.MarkdownString(contents),
                            );
                        }
                        else if (attr.startValue && attr.startValue <= offset) {
                            // TODO:
                        }
                    }
                }
            }
        }

        if (token.isCancellationRequested) return void 0;

        return hv;
    }
}
