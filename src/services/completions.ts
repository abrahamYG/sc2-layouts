import * as util from 'util';
import * as vs from 'vscode';
import * as sch from '../schema/base';
import { AbstractProvider, svcRequest, ILoggerConsole } from './provider';
import { ServiceContext, ExtConfigCompletionTabStopKind } from '../service';
import { createScanner, CharacterCodes } from '../parser/scanner';
import { TokenType, ScannerState, XMLElement, AttrValueKind, XMLNodeKind, AttrValueKindOp } from '../types';
import { DescIndex, DescNamespace, DescKind } from '../index/desc';
import * as s2 from '../index/s2mod';
import { Store } from '../index/store';
import { ExpressionParser, SelHandleKind, SelectorFragment, PathSelector, PropertyBindExpr, SyntaxKind } from '../parser/expressions';
import { UINavigator, UIBuilder, FrameNode, AnimationNode, StateGroupNode, UINode } from '../index/hierarchy';
import { getSelectionIndexAtPosition, getAttrValueKind, isConstantValue } from '../parser/utils';
import { LayoutProcessor } from '../index/processor';
import { XRay } from '../index/xray';
import { LayoutChecker } from '../index/checker';
import { reValueColor } from '../schema/validation';
import { parseColorLiteral, getColorAsHexARGB } from './color';

function completionsForSimpleType(smType: sch.SimpleType) {
    let items = <vs.CompletionItem[]> [];

    if (smType.union) {
        for (const unSmType of smType.union) {
            items = items.concat(completionsForSimpleType(unSmType));
        }
    }

    if (smType.emap) {
        for (const e of smType.emap.values()) {
            const tc = <vs.CompletionItem>{
                label: e.name,
                kind: vs.CompletionItemKind.EnumMember,
                detail: e.label,
                documentation: new vs.MarkdownString(`\`[${smType.name}]\``),
            };
            items.push(tc);
        }
    }

    return items;
}

function completionFromDescItem(descItem: DescNamespace) {
    return <vs.CompletionItem>{
        kind: descKindToCompletionKind(descItem.kind),
        label: descItem.name,
        detail: `${descItem.stype.name} (${descItem.children.size})`,
    };
}

function completionFromUNodeItem(uNode: UINode) {
    const compl = completionFromDescItem(uNode.mainDesc);
    compl.detail = `${uNode.mainDesc.stype.name} (${uNode.children.size})`;
    return compl;
}

function descKindToCompletionKind(dkind: DescKind) {
    switch (dkind) {
        case DescKind.Root:
        case DescKind.File:
            return vs.CompletionItemKind.Module;
        case DescKind.Frame:
            return vs.CompletionItemKind.Struct;
        case DescKind.Animation:
            return vs.CompletionItemKind.Event;
        case DescKind.StateGroup:
            return vs.CompletionItemKind.Class;
    }
    return vs.CompletionItemKind.Folder;
}

interface ComplContext {
    citems: vs.CompletionItem[];
    node: XMLElement;
    offset: number;
    xtokenText: string;
    xtoken: TokenType;
    xstate: ScannerState;
}

interface AtComplContext extends ComplContext {
    attrName: string;
    attrNameLower: string;
}

interface AtValComplContext extends AtComplContext {
    attrValue: string;
    atOffsetRelative: number;
}

class SuggestionsProvider {
    protected exParser = new ExpressionParser();
    protected uNavigator: UINavigator;
    protected uBuilder: UIBuilder;
    protected processor: LayoutProcessor;
    protected checker: LayoutChecker;
    protected dIndex: DescIndex;
    protected xray: XRay;

    protected prepare() {
        this.uNavigator = new UINavigator(this.store.schema, this.store.index);
        this.uBuilder = new UIBuilder(this.store.schema, this.store.index);
        this.processor = new LayoutProcessor(this.store, this.store.index);
        this.checker = new LayoutChecker(this.store, this.store.index);
        this.dIndex = this.store.index;
        this.xray = new XRay(this.store);
    }

    constructor(protected store: Store, protected console: ILoggerConsole) {
        this.prepare();
    }
}

// ====

class AttrValueProvider extends SuggestionsProvider {
    protected suggestPropNames(ctx: AtComplContext) {
        for (const props of this.store.schema.frameClassProps.values()) {
            ctx.citems.push({
                kind: vs.CompletionItemKind.Property,
                label: props[0].name,
                detail: `[${props[0].fclass.name}] ${props[0].etype.type.name}`,
                documentation: props[0].etype.label,
            });
        }
    }

    protected suggestPropertyBind(ctx: AtValComplContext, currentDesc: DescNamespace) {
        const pbindSel = this.exParser.parsePropertyBind(ctx.attrValue);

        if (pbindSel.path.pos <= ctx.atOffsetRelative && pbindSel.path.end >= ctx.atOffsetRelative) {
            this.suggestSelection(ctx, pbindSel, sch.BuiltinTypeKind.FrameReference, currentDesc);
        }
        else {
            this.suggestPropNames(ctx);
        }
    }

    protected suggestSelection(ctx: AtValComplContext, pathSel: PathSelector | PropertyBindExpr, smType: sch.BuiltinTypeKind, currentDesc: DescNamespace) {
        function appendDescChildren(descChildren: DescNamespace[] | IterableIterator<DescNamespace>) {
            for (const item of descChildren) {
                ctx.citems.push(completionFromDescItem(item));
            }
        }

        function appendUNodeChildren(uNodeChildren: UINode[] | IterableIterator<UINode>) {
            const frameChildren = Array.from(uNodeChildren).filter(item => item.mainDesc.kind === DescKind.Frame);
            for (const item of frameChildren) {
                ctx.citems.push(completionFromUNodeItem(item));
            }
        }

        let pathIndex = getSelectionIndexAtPosition(pathSel, ctx.atOffsetRelative);

        switch (smType) {
            case sch.BuiltinTypeKind.FileDescName:
            case sch.BuiltinTypeKind.DescTemplateName:
            {
                if (pathIndex === void 0) pathIndex = 0;
                if (smType === sch.BuiltinTypeKind.FileDescName && pathIndex > 0) break;

                const fragments = pathSel.path.map(item => item.name.name).slice(0, pathIndex);
                const dsItem = this.dIndex.rootNs.getMulti(...fragments);
                if (!dsItem) break;

                appendDescChildren(dsItem.children.values());
                break;
            }

            case sch.BuiltinTypeKind.DescName:
            {
                if (!currentDesc.file) break;
                const fileDesc = this.dIndex.rootNs.get(currentDesc.file);
                if (!fileDesc) break;

                if (pathIndex === void 0 || pathIndex === 0) {
                    appendDescChildren(fileDesc.children.values());
                    break;
                }

                const topDesc = fileDesc.get(pathSel.path[0].name.name);
                if (!topDesc) break;
                const fragments = pathSel.path.map(item => item).slice(1);

                const uNode = this.uBuilder.buildNodeFromDesc(topDesc);
                if (!uNode) break;
                let uTargetNode = uNode;
                if (pathIndex !== void 0 && pathIndex > 1) {
                    const resolvedSel = this.uNavigator.resolveSelection(uNode, fragments);
                    if (resolvedSel.chain.length <= pathIndex - 2) break;
                    uTargetNode = resolvedSel.chain[pathIndex - 2];
                }

                appendUNodeChildren(uTargetNode.children.values());
                break;
            }

            case sch.BuiltinTypeKind.DescInternal:
            {
                if (pathIndex === void 0 || pathIndex === 0) {
                    ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$root'});
                    const uNode = this.uBuilder.buildNodeFromDesc(currentDesc);
                    appendUNodeChildren(uNode.children.values());
                }
                else {
                    const resolvedDesc = this.checker.resolveDescPath(currentDesc, <PathSelector>pathSel);
                    if (resolvedDesc.items.length < pathIndex - 1) break;
                    for (const descItem of resolvedDesc.items[pathIndex - 1]) {
                        appendDescChildren(descItem.children.values());
                    }
                }
                break;
            }

            case sch.BuiltinTypeKind.FrameReference:
            {
                let uNode: UINode;
                if (pathSel.kind === SyntaxKind.PropertyBindExpr) {
                    uNode = this.xray.determineActionFrameNode(ctx.node);
                }
                else {
                    uNode = this.xray.determineCurrentFrameNode(ctx.node);
                }
                if (!uNode) break;

                let uTargetNode = uNode;
                if (pathIndex !== void 0 && pathIndex > 0) {
                    const resolvedSel = this.uNavigator.resolveSelection(uNode, pathSel.path);
                    if (resolvedSel.chain.length <= pathIndex - 1) break;
                    uTargetNode = resolvedSel.chain[pathIndex - 1];
                }

                let selFrag: SelectorFragment;
                if (pathIndex !== void 0) {
                    selFrag = pathSel.path[pathIndex];
                    if (
                        (selFrag.selKind === SelHandleKind.Ancestor && selFrag.parameter) &&
                        (selFrag.parameter.pos <= ctx.atOffsetRelative && selFrag.parameter.end >= ctx.atOffsetRelative)
                    ) {
                        if (selFrag.parameter.key && selFrag.parameter.key.pos <= ctx.atOffsetRelative && selFrag.parameter.key.end >= ctx.atOffsetRelative) {
                            ctx.citems.push({kind: vs.CompletionItemKind.Operator, label: 'type', });
                            ctx.citems.push({kind: vs.CompletionItemKind.Operator, label: 'oftype', });
                            ctx.citems.push({kind: vs.CompletionItemKind.Operator, label: 'name', });
                        }
                        else if (selFrag.parameter.value && selFrag.parameter.value.pos <= ctx.atOffsetRelative && selFrag.parameter.value.end >= ctx.atOffsetRelative) {
                            switch (selFrag.parameter.key.name) {
                                case 'oftype':
                                case 'type':
                                {
                                    for (const tmp of this.store.schema.frameTypes.values()) {
                                        ctx.citems.push({
                                            kind: vs.CompletionItemKind.EnumMember,
                                            label: tmp.name,
                                            detail: Array.from(tmp.fclasses.values()).map(fc => `${fc.name}`).join(' :: '),
                                        });
                                    }
                                    break;
                                }

                                case 'name':
                                {
                                    let cparent = uTargetNode;
                                    while (cparent = cparent.parent) {
                                        if (cparent.mainDesc.kind !== DescKind.Frame) break;
                                        const compl = completionFromUNodeItem(cparent);
                                        compl.documentation = new vs.MarkdownString(`\`${cparent.mainDesc.fqn}\``);
                                        ctx.citems.push(compl);
                                    }
                                    break;
                                }
                            }
                        }
                        break;
                    }
                }

                appendUNodeChildren(uTargetNode.children.values());

                if (selFrag) {
                    switch (selFrag.selKind) {
                        case SelHandleKind.This:
                        case SelHandleKind.Parent:
                        case SelHandleKind.Root:
                        case SelHandleKind.Layer:
                        case SelHandleKind.Sibling:
                        case SelHandleKind.Ancestor:
                        case SelHandleKind.Custom:
                        {
                            ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$parent', preselect: true});
                            ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$this', preselect: true});
                            ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$sibling', preselect: false});
                            ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$ancestor', preselect: false});
                            if (pathIndex === 0) {
                                ctx.citems.push({kind: vs.CompletionItemKind.Keyword, label: '$layer', preselect: false});
                            }
                            break;
                        }
                    }
                }

                if (pathIndex === 0) {
                    if (selFrag.selKind !== SelHandleKind.Identifier) {
                        for (const item of this.dIndex.handles.values()) {
                            ctx.citems.push({
                                kind: vs.CompletionItemKind.Variable,
                                label: `$${item.name}`,
                                detail: `[${item.desc.stype.name}]\n${item.desc.fqn}`,
                            });
                        }
                    }
                }
                break;
            }
        }
    }

    protected suggestFontStyles(ctx: AtValComplContext) {
        for (const item of this.store.s2ws.styles.values) {
            ctx.citems.push({
                kind: vs.CompletionItemKind.Reference,
                label: item.name,
                detail: Array.from(item.archives.values()).map(a => a.name).join(' ; '),
            });
        }
    }

    protected suggestStrings(ctx: AtValComplContext, strfKind: s2.StringFileKind) {
        const rl = this.store.s2ws.strings.file(strfKind).entriesStartingWith(
            ctx.attrValue.substring(
                getAttrValueKind(ctx.attrValue) === AttrValueKind.AssetRacial ? 2 : 1,
                ctx.atOffsetRelative
            )
        );
        for (const [ikey, item] of rl) {
            if (item.partial) {
                ctx.citems.push({
                    kind: vs.CompletionItemKind.Folder,
                    label: ikey,
                });
            }
            else {
                ctx.citems.push({
                    kind: vs.CompletionItemKind.Reference,
                    label: ikey,
                    detail: item.result.value,
                    documentation: item.result.archive.name,
                });
            }
        }
    }

    protected suggestDescNames(ctx: AtValComplContext) {
        const xElParent = <XMLElement>ctx.node.parent;
        if (!xElParent.sdef) return;
        switch (xElParent.sdef.nodeKind) {
            case sch.ElementDefKind.Frame:
            case sch.ElementDefKind.Animation:
            case sch.ElementDefKind.StateGroup:
                break;

            default:
                return;
        }

        const parentDesc = this.store.index.resolveElementDesc(xElParent);
        const currentDesc = this.store.index.resolveElementDesc(ctx.node);

        const uParentNode = this.uBuilder.buildNodeFromDesc(parentDesc);
        if (!uParentNode) return;

        for (const uChild of this.uNavigator.getChildrenOfType(uParentNode, currentDesc.kind).values()) {
            const dscList = Array.from(uChild.descs);
            const mIndex = dscList.findIndex((value) => {
                if (value.xDecls.has(ctx.node) && uChild.descs.size > 1) return false;
                if (value.parent !== parentDesc) return false;
                return true;
            });
            if (mIndex !== -1) continue;

            ctx.citems.push({
                label: uChild.name,
                kind: vs.CompletionItemKind.Value,
                detail: `[${uChild.mainDesc.stype.name}]`,
                documentation: new vs.MarkdownString(`${uChild.mainDesc.fqn.replace(/\//g, '/\\\n')}`),
            });
        }
    }

    protected suggestEventNames(ctx: AtValComplContext, sAttrType: sch.SimpleType) {
        switch (ctx.node.sdef.nodeKind) {
            case sch.ElementDefKind.AnimationControllerKey:
            case sch.ElementDefKind.StateGroupStateAction:
            {
                const uNode = this.xray.determineTargetFrameNode(ctx.node);
                if (!uNode) return;
                for (const aNode of this.uNavigator.getChildrenOfType<AnimationNode>(uNode, DescKind.Animation).values()) {
                    for (const [evName, evXEl] of aNode.getEvents()) {
                        ctx.citems.push({
                            kind: vs.CompletionItemKind.Event,
                            label: evName,
                            detail: `[${aNode.name}] ${evXEl.map(item => item.getAttributeValue('action')).join(' | ')}`,
                        });
                    }
                }
                return;
            }

            case sch.ElementDefKind.AnimationEvent: break;
        }
        ctx.citems = ctx.citems.concat(completionsForSimpleType(sAttrType).map(item => {
            item.preselect = true;
            return item;
        }));
    }

    protected suggestAnimNames(ctx: AtValComplContext) {
        const uNode = this.xray.determineTargetFrameNode(ctx.node);
        if (!uNode) return;
        for (const aNode of this.uNavigator.getChildrenOfType<AnimationNode>(uNode, DescKind.Animation).values()) {
            ctx.citems.push({
                label: aNode.name,
                kind: vs.CompletionItemKind.Variable,
            });
        }
    }

    protected suggestStateGroupNames(ctx: AtValComplContext) {
        const uNode = this.xray.determineTargetFrameNode(ctx.node);
        if (!uNode) return;
        for (const aNode of this.uNavigator.getChildrenOfType<StateGroupNode>(uNode, DescKind.StateGroup).values()) {
            let docs = '';
            docs += `**DefaultState:** ${aNode.defaultState ? `\`${aNode.defaultState}\`` : '* - None - *'}\\\n`;
            docs += '**States:** ' + Array.from(aNode.states.values()).map((item, key) => {
                return `\`${item[0].getAttributeValue('name', '-')}\``;
            }).join(', ') + '\\\n';
            docs += `**Context:**\\\n${aNode.parentNodes.map(item => `\\- ${item.name} \`[${item.constructor.name}]\``).join('\\\n')}`;
            ctx.citems.push({
                label: aNode.name,
                kind: vs.CompletionItemKind.Class,
                detail: aNode.parent ? `${aNode.parent.name} [parent]` : void 0,
                documentation: new vs.MarkdownString(docs),
            });
        }
    }

    protected suggestStateGroupStateNames(ctx: AtValComplContext) {
        const sgNode = this.xray.determineTargetStateGroup(ctx.node);
        if (!sgNode) return;
        for (const xElState of sgNode.states.values()) {
            ctx.citems.push({
                label: xElState[0].getAttributeValue('name'),
                kind: vs.CompletionItemKind.Interface,
                detail: sgNode.parent ? `${sgNode.name} — ${sgNode.parent.name} [parent]` : void 0,
            });
        }
    }

    protected suggestPropertyNames(ctx: AtValComplContext) {
        const uFrame = this.xray.determineTargetFrameNode(ctx.node);
        if (uFrame) {
            const sfType = this.store.schema.getFrameType(Array.from(uFrame.mainDesc.xDecls)[0].stype);
            if (sfType) {
                for (const currScProp of sfType.fprops.values()) {
                    ctx.citems.push({
                        label: currScProp.name,
                        kind: vs.CompletionItemKind.Variable,
                        detail: `Property of ${currScProp.fclass.name}`,
                    });
                }
                return;
            }
        }

        for (const props of this.store.schema.frameClassProps.values()) {
            ctx.citems.push({
                label: props[0].name,
                kind: vs.CompletionItemKind.Property,
                detail: `Property of ${props.map(item => item.fclass.name).join(',')}`,
            });
        }
    }

    public provide(ctx: AtValComplContext) {
        const sAttrItem = ctx.node.stype.attributes.get(ctx.attrNameLower);
        let sAttrType: sch.SimpleType;
        if (sAttrItem) {
            sAttrType = sAttrItem.type;
        }
        else {
            const indType = this.xray.matchIndeterminateAttr(ctx.node, ctx.attrName);
            if (!indType) return;
            sAttrType = indType.value;
        }

        const pvKind = getAttrValueKind(ctx.attrValue);
        const isAssetRef = (pvKind === AttrValueKind.Asset || pvKind === AttrValueKind.AssetRacial);
        const currentDesc = this.store.index.resolveElementDesc(ctx.node);

        if (this.store.schema.isPropertyBindAllowed(ctx.node.sdef, ctx.node.stype, ctx.attrName) && pvKind === AttrValueKind.PropertyBind) {
            this.suggestPropertyBind(ctx, currentDesc);
            return;
        }

        switch (sAttrType.builtinType) {
            case sch.BuiltinTypeKind.Style:
                this.suggestFontStyles(ctx);
                break;

            case sch.BuiltinTypeKind.Image:
                if (isAssetRef) this.suggestStrings(ctx, s2.StringFileKind.Assets);
                break;

            case sch.BuiltinTypeKind.Text:
                if (isAssetRef) this.suggestStrings(ctx, s2.StringFileKind.GameStrings);
                break;

            case sch.BuiltinTypeKind.Hotkey:
                if (isAssetRef) this.suggestStrings(ctx, s2.StringFileKind.GameHotkeys);
                break;

            case sch.BuiltinTypeKind.DescName:
            {
                if (!currentDesc) break;
                if (!currentDesc.file) {
                    this.suggestDescNames(ctx);
                    break;
                }
                else {
                    this.suggestSelection(ctx, this.exParser.parsePathSelector(ctx.attrValue), sAttrType.builtinType, currentDesc);
                }
            }

            case sch.BuiltinTypeKind.DescTemplateName:
            case sch.BuiltinTypeKind.DescInternal:
            case sch.BuiltinTypeKind.FileDescName:
            case sch.BuiltinTypeKind.FrameReference:
            {
                if (!currentDesc) break;
                this.suggestSelection(ctx, this.exParser.parsePathSelector(ctx.attrValue), sAttrType.builtinType, currentDesc);
                break;
            }

            case sch.BuiltinTypeKind.EventName:
            {
                this.suggestEventNames(ctx, sAttrType);
                break;
            }

            case sch.BuiltinTypeKind.AnimationName:
            {
                this.suggestAnimNames(ctx);
                break;
            }

            case sch.BuiltinTypeKind.StateGroupName:
            {
                this.suggestStateGroupNames(ctx);
                break;
            }

            case sch.BuiltinTypeKind.StateGroupStateName:
            {
                this.suggestStateGroupStateNames(ctx);
                break;
            }

            case sch.BuiltinTypeKind.PropertyName:
            {
                this.suggestPropertyNames(ctx);
                break;
            }

            case sch.BuiltinTypeKind.PropertyValue:
            {
                const propListType = this.processor.getElPropertyType(ctx.node, ctx.attrNameLower);
                completionsForSimpleType(propListType).forEach(r => { ctx.citems.push(r); });
                break;
            }

            default:
            {
                completionsForSimpleType(sAttrType).forEach(r => { ctx.citems.push(r); });
                break;
            }
        }
    }
}

// ====

class AttrNameProvider extends SuggestionsProvider {
    protected matchIndeterminateAttr(ctx: AtComplContext) {
        if (!ctx.node.stype.indeterminateAttributes.size) return;

        for (const [sname, sattr] of ctx.node.stype.attributes) {
            if (!sattr.required) continue;
            if (!ctx.node.attributes[sname]) return;
        }

        for (const atKey in ctx.node.attributes) {
            if (ctx.node.stype.attributes.has(atKey)) continue;
            if (ctx.node.attributes[atKey].name !== ctx.attrName) {
                return;
            }
            break;
        }

        return Array.from(ctx.node.stype.indeterminateAttributes.values())[0];
    }

    public provide(ctx: AtComplContext) {
        let atHasValue = false;
        if (ctx.attrNameLower && ctx.node.attributes[ctx.attrNameLower]) {
            atHasValue = ctx.node.attributes[ctx.attrNameLower].startValue !== void 0;
        }

        function createCompletion(name: string, opts: { detail?: string, triggerSuggest?: boolean } = {}) {
            const tmpc = <vs.CompletionItem>{
                label: name,
                kind: vs.CompletionItemKind.Variable,
                detail: opts.detail ? opts.detail : void 0,
            };
            if (!atHasValue) {
                tmpc.insertText = new vs.SnippetString(`${name}="\$0"`);
                if (opts.triggerSuggest) {
                    tmpc.command = {command: 'editor.action.triggerSuggest', title: ''};
                }
            }
            return tmpc;
        }

        for (const [sAttrKey, sAttrItem] of ctx.node.stype.attributes) {
            if (
                (ctx.node.attributes[sAttrKey] && ctx.node.attributes[sAttrKey].startValue) &&
                (ctx.xtoken !== TokenType.AttributeName || ctx.attrNameLower !== sAttrKey)
            ) {
                continue;
            }
            const tmpc = <vs.CompletionItem>{
                label: sAttrItem.name + (sAttrItem.required ? '' : '?'),
                filterText: sAttrItem.name,
                kind: vs.CompletionItemKind.Field,
                detail: sAttrItem.type.name,
                documentation: new vs.MarkdownString(sAttrItem.label),
                insertText: sAttrItem.name,
            };
            if (!atHasValue) {
                tmpc.insertText = new vs.SnippetString(`${sAttrItem.name}="\$0"`);
                tmpc.command = sAttrItem.type.builtinType !== sch.BuiltinTypeKind.String ? {command: 'editor.action.triggerSuggest', title: ''} : void 0;
            }
            ctx.citems.push(tmpc);
        }

        const indAttr = this.matchIndeterminateAttr(ctx);
        if (indAttr) {
            const uFrame = this.xray.determineTargetFrameNode(ctx.node);

            switch (indAttr.key.builtinType) {
                case sch.BuiltinTypeKind.AnimationName:
                {
                    if (!uFrame) return;
                    for (const uAnim of this.uNavigator.getChildrenOfType(uFrame, DescKind.Animation).values()) {
                        ctx.citems.push(createCompletion(uAnim.name, {
                            detail: `[${indAttr.key.name}]`,
                            triggerSuggest: true,
                        }));
                    }
                    break;
                }

                case sch.BuiltinTypeKind.StateGroupName:
                {
                    if (!uFrame) return;
                    for (const sgNode of this.uNavigator.getChildrenOfType<StateGroupNode>(uFrame, DescKind.StateGroup).values()) {
                        ctx.citems.push(createCompletion(sgNode.name, {
                            detail: `[${indAttr.key.name}]`,
                            triggerSuggest: true,
                        }));
                    }
                    break;
                }

                case sch.BuiltinTypeKind.PropertyName:
                {
                    let sfType: sch.FrameType;
                    if (uFrame) {
                        sfType = this.store.schema.getFrameType(Array.from(uFrame.mainDesc.xDecls)[0].stype);
                        if (sfType) {
                            for (const currScProp of sfType.fprops.values()) {
                                ctx.citems.push(createCompletion(currScProp.name, {
                                    detail: `Property of ${currScProp.fclass.name}`,
                                    triggerSuggest: true,
                                }));
                            }
                        }
                        break;
                    }

                    for (const props of this.store.schema.frameClassProps.values()) {
                        ctx.citems.push(createCompletion(props[0].name, {
                            detail: `Property of ${props.map(item => item.fclass.name).join(',')}`,
                            triggerSuggest: true,
                        }));
                    }
                    break;
                }
            }
        }

    }
}

// ====

export class CompletionsProvider extends AbstractProvider implements vs.CompletionItemProvider {
    protected atValueProvider: AttrValueProvider;
    protected atNameProvider: AttrNameProvider;

    protected provideConstants(compls: vs.CompletionItem[], vKind: AttrValueKind) {
        for (const item of this.store.index.constants.values()) {
            const compl = <vs.CompletionItem>{
                kind: vs.CompletionItemKind.Constant,
                label: AttrValueKindOp[vKind] + `${item.name}`,
                detail: item.value,
            };

            const constChain = this.dIndex.resolveConstantDeep(item.name);
            let finalValue: string;
            if (constChain) {
                finalValue = constChain[constChain.length - 1].value;
            }
            else {
                finalValue = item.value;
            }

            if (reValueColor.test(finalValue)) {
                compl.kind = vs.CompletionItemKind.Color;
                compl.documentation = `#${getColorAsHexARGB(parseColorLiteral(finalValue.trim()).vColor)}`;
            }
            compls.push(compl);
        }
    }

    protected suggestAnchors(ctx: ComplContext, nodeCtx: XMLElement) {
        const scElAnchor = nodeCtx.stype.struct.get('Anchor');
        for (const side of ['Left', 'Right', 'Top', 'Bottom']) {
            const complItem = <vs.CompletionItem>{
                label: `${scElAnchor.name}:${side}`,
                kind: vs.CompletionItemKind.Property,
                detail: scElAnchor.label,
            };
            complItem.insertText = (ctx.xtoken === TokenType.Content ? '<' : '') + `${scElAnchor.name}`;
            let i = 0;
            for (const stInfo of scElAnchor.type.attributes.values()) {
                let v: string;
                switch (stInfo.name) {
                    case 'side':
                        v = side;
                        break;
                    case 'relative':
                        v = '${' + (++i) + ':\\$parent}';
                        break;
                    case 'pos':
                        switch (side) {
                            case 'Left':
                            case 'Top':
                                v = '${' + (++i) + ':Min}';
                                break;
                            case 'Right':
                            case 'Bottom':
                                v = '${' + (++i) + ':Max}';
                                break;
                        }
                        break;
                    case 'offset':
                        v = '${' + (++i) + ':0}';
                        break;
                    default:
                        v = `\$${++i}`;
                        break;
                }
                complItem.insertText += ` ${stInfo.name}="${v}"`;
            }
            complItem.insertText += '/>';
            complItem.insertText = new vs.SnippetString(complItem.insertText);
            ctx.citems.push(complItem);
        }
    }

    protected suggestStateGroup(ctx: ComplContext, nodeCtx: XMLElement) {
        const category = 'StateGroup';
        const itemSch = nodeCtx.stype.struct.get(category);
        for (let l = 1; l <= 5; ++l) {
            const complItem = <vs.CompletionItem>{
                label: `${category}:${l}`,
                kind: vs.CompletionItemKind.Interface,
                detail: itemSch.name,
            };

            let defaultStateName: string;
            if (typeof this.svcContext.config.completion.stategroupDefaultState === 'string') {
                defaultStateName = this.svcContext.config.completion.stategroupDefaultState;
            }
            else if (this.svcContext.config.completion.stategroupDefaultState === true) {
                defaultStateName = 'Default';
            }

            let i = 0;
            complItem.insertText = (ctx.xtoken === TokenType.Content ? '<' : '') + `${category} name="\${${++i}:${category + l.toString()}}">`;
            if (defaultStateName !== void 0) {
                complItem.insertText += `\n\t<DefaultState val="\${${l + 2}:${defaultStateName}}"/>\n`;
            }
            for (let j = 1; j <= l; ++j) {
                complItem.insertText += `\n\t<State name="\${${j + 1}:${j}}">\n\t</State>\n`;
            }
            if (defaultStateName !== void 0) {
                complItem.insertText += `\n\t<State name="\${${l + 2}:${defaultStateName}}">\n\t</State>\n`;
            }
            complItem.insertText += `</${category}>`;

            complItem.documentation = new vs.MarkdownString();
            complItem.documentation.appendCodeblock(complItem.insertText, 'sc2layout');
            complItem.insertText = new vs.SnippetString(complItem.insertText);
            ctx.citems.push(complItem);
        }
    }

    protected suggestStateGroupInstruction(ctx: ComplContext, nodeCtx: XMLElement) {
        for (const category of ['When', 'Action']) {
            for (const [itemType, itemSch] of nodeCtx.stype.struct.get(category).alternateTypes) {
                const complItem = <vs.CompletionItem>{
                    label: `${category}:${itemType}`,
                    kind: vs.CompletionItemKind.Method,
                    detail: itemSch.name,
                };
                complItem.insertText = (ctx.xtoken === TokenType.Content ? '<' : '') + `${category}`;
                let i = 0;
                outer: for (const stInfo of itemSch.attributes.values()) {
                    let val: string;
                    switch (stInfo.name) {
                        case 'type':
                        {
                            val = itemType;
                            break;
                        }

                        default:
                        {
                            if (!stInfo.required && !stInfo.default) continue outer;
                            if (stInfo.default) {
                                complItem.insertText += ` ${stInfo.name}="\${${++i}:${stInfo.default.replace('$', '\\$')}}"`;
                            }
                            else {
                                complItem.insertText += ` ${stInfo.name}="\$${++i}"`;
                            }
                            continue outer;
                        }
                    }
                    complItem.insertText += ` ${stInfo.name}="${val}"`;
                }
                if (itemSch.indeterminateAttributes.size > 0) {
                    complItem.insertText += ` $0`;
                }
                complItem.insertText += '/>';
                complItem.insertText = new vs.SnippetString(complItem.insertText);
                ctx.citems.push(complItem);
            }
        }
    }

    protected suggestAnimationController(ctx: ComplContext, nodeCtx: XMLElement) {
        const category = 'Controller';
        for (const [itemType, itemSch] of nodeCtx.stype.struct.get(category).alternateTypes) {
            const complItem = <vs.CompletionItem>{
                label: `${category}:${itemType}`,
                kind: vs.CompletionItemKind.Method,
                detail: itemSch.name,
            };
            complItem.insertText = (ctx.xtoken === TokenType.Content ? '<' : '') + `${category}`;
            let i = 0;
            outer: for (const stInfo of itemSch.attributes.values()) {
                let val: string;
                switch (stInfo.name) {
                    case 'type':
                    {
                        val = itemType;
                        break;
                    }

                    default:
                    {
                        if (!stInfo.required && !stInfo.default) continue outer;
                        if (stInfo.default) {
                            complItem.insertText += ` ${stInfo.name}="\${${++i}:${stInfo.default.replace('$', '\\$')}}"`;
                        }
                        else {
                            complItem.insertText += ` ${stInfo.name}="\$${++i}"`;
                        }
                        continue outer;
                    }
                }
                complItem.insertText += ` ${stInfo.name}="${val}"`;
            }
            complItem.insertText += `>\$0</${category}>`;
            complItem.insertText = new vs.SnippetString(complItem.insertText);
            ctx.citems.push(complItem);
        }
    }

    protected suggestElements(ctx: ComplContext) {
        let nodeCtx = ctx.node;
        if (ctx.offset < ctx.node.startTagEnd || (ctx.offset >= ctx.node.end && ctx.node.parent.kind === XMLNodeKind.Element)) {
            nodeCtx = <XMLElement>ctx.node.parent;
        }
        if (!nodeCtx.stype) return;

        const isNewTag =
            ((ctx.xtoken === TokenType.Content || ctx.xtoken === TokenType.StartTagOpen) || !ctx.node.closed) &&
            [CharacterCodes.greaterThan].find(v => v === ctx.node.getDocument().tdoc.getText().charCodeAt(ctx.offset)) === void 0
        ;

        if (isNewTag) {
            switch (nodeCtx.sdef.nodeKind) {
                case sch.ElementDefKind.Frame:
                    this.suggestAnchors(ctx, nodeCtx);
                    this.suggestStateGroup(ctx, nodeCtx);
                    break;
                case sch.ElementDefKind.StateGroupState:
                    this.suggestStateGroupInstruction(ctx, nodeCtx);
                    break;
                case sch.ElementDefKind.Animation:
                    this.suggestAnimationController(ctx, nodeCtx);
                    break;
            }
        }

        for (const [sElKey, sElItem] of nodeCtx.stype.struct) {
            const complItem = <vs.CompletionItem>{
                label: sElKey,
                kind: sElItem.nodeKind === sch.ElementDefKind.FrameProperty ? vs.CompletionItemKind.Property : vs.CompletionItemKind.Struct,
                // detail: sElItem.type.name,
                detail: typeof sElItem.label !== 'undefined' ? sElItem.label : void 0
            };

            switch (sElItem.nodeKind) {
                case sch.ElementDefKind.FrameProperty:
                {
                    complItem.label = `${sElKey} [${this.store.schema.getFrameProperty(sElItem).fclass.name}]`;
                    complItem.filterText = sElKey;
                    complItem.insertText = sElKey;
                    break;
                }
            }

            if (isNewTag) {
                complItem.insertText = (ctx.xtoken === TokenType.Content ? '<' : '') + `${sElKey}`;
                let i = 0;
                for (const stInfo of sElItem.type.attributes.values()) {
                    if (!stInfo.required && !stInfo.default) continue;
                    if (stInfo.default) {
                        complItem.insertText += ` ${stInfo.name}="\${${++i}:${stInfo.default.replace('$', '\\$')}}"`;
                    }
                    else {
                        complItem.insertText += ` ${stInfo.name}="\$${++i}"`;
                    }
                }
                if (!sElItem.type.struct.size && sElItem.nodeKind !== sch.ElementDefKind.Frame) {
                    if (i === 1 && this.svcContext.config.completion.tabStop === ExtConfigCompletionTabStopKind.Attr) {
                        complItem.insertText = complItem.insertText.replace('$1', '$0');
                    }
                    complItem.insertText += '/>';
                }
                else {
                    complItem.insertText += `>\$0</${sElKey}>`;
                }
                complItem.insertText = new vs.SnippetString(complItem.insertText);
            }

            ctx.citems.push(complItem);
        }
    }

    public init(svcContext: ServiceContext, store: Store, console: ILoggerConsole) {
        super.init(svcContext, store, console);
        this.atValueProvider = new AttrValueProvider(this.store, console);
        this.atNameProvider = new AttrNameProvider(this.store, console);
    }

    @svcRequest(
        false,
        (document: vs.TextDocument, position: vs.Position, cancToken: vs.CancellationToken, context: vs.CompletionContext) => {
            return {
                filename: document.uri.fsPath,
                position: {line: position.line, char: position.character},
                context,
            };
        },
        (r: vs.CompletionList) => r.items.length
    )
    async provideCompletionItems(document: vs.TextDocument, position: vs.Position, cancToken: vs.CancellationToken, context: vs.CompletionContext) {
        let items = <vs.CompletionItem[]> [];
        const sourceFile = await this.svcContext.syncVsDocument(document);
        const offset = document.offsetAt(position);
        const node = sourceFile.findNodeAt(offset);

        if (!node || !(node instanceof XMLElement)) {
            if (!sourceFile.getRootNode()) {
                items.push({
                    kind: vs.CompletionItemKind.Snippet,
                    label: 'fdesc',
                    detail: 'Desc template',
                    insertText: new vs.SnippetString(
                        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n' +
                        '<Desc>$0\n</Desc>'
                    ),
                });
                return {items};
            }
            return;
        }

        let startOffset = offset;
        if (node) {
            // console.log('node', node.start, node.end, node.stype ? node.stype.name : '?');
            startOffset = node.start;
        }
        else {
            startOffset = document.offsetAt(document.getWordRangeAtPosition(position).start);
        }

        // console.log('offset', offset);
        let scanner = createScanner(document.getText(), startOffset);
        let token = scanner.scan();
        let currentAttrName: string;
        outer: while (token !== TokenType.EOS) {
            // console.log(scanner.getTokenOffset(), scanner.getTokenEnd(), TokenType[token], ScannerState[scanner.getScannerState()], scanner.getTokenText());
            if (token === TokenType.AttributeName) {
                currentAttrName = scanner.getTokenText();
            }
            if (scanner.getTokenEnd() > offset) break;
            if (scanner.getTokenEnd() === offset) {
                switch (token) {
                    case TokenType.StartTagOpen:
                    case TokenType.StartTag:
                    case TokenType.StartTagClose:
                    case TokenType.EndTag:
                    case TokenType.EndTagOpen:
                    case TokenType.Content:
                    case TokenType.AttributeName:
                    case TokenType.DelimiterAssign:
                    case TokenType.Whitespace:
                        break outer;
                    default:
                        break;
                }
            }
            token = scanner.scan();
        }
        // if (currentAttrName !== void 0) {
        //     currentAttrName = currentAttrName.toLowerCase();
        // }
        const tokenText = scanner.getTokenText();
        const cmCtx = <ComplContext>{
            citems: items,
            offset: offset,
            node: node,
            xtoken: token,
            xstate: scanner.getScannerState(),
            xtokenText: scanner.getTokenText(),
        };

        if (scanner.getScannerState() === ScannerState.AfterOpeningEndTag || scanner.getScannerState() === ScannerState.WithinEndTag) {
            items.push(<vs.CompletionItem>{
                label: `/${node.tag}`,
                kind: vs.CompletionItemKind.Struct,
                insertText: node.tag + (document.getText().charCodeAt(scanner.getTokenEnd()) === CharacterCodes.greaterThan ? '' : '>'),
                command: { command: 'editor.action.reindentselectedlines' },
            });
        }

        switch (token) {
            case TokenType.AttributeName:
            case TokenType.Whitespace:
            case TokenType.StartTagClose:
            case TokenType.StartTagSelfClose:
            {
                if (scanner.getScannerState() === ScannerState.AfterOpeningEndTag) break;
                if (scanner.getScannerState() === ScannerState.WithinContent) break;
                if (!node.stype) return;
                const cmAtCtx = <AtComplContext>cmCtx;
                switch (cmCtx.xtoken) {
                    case TokenType.AttributeName:
                    case TokenType.StartTag:
                    {
                        cmAtCtx.attrName = currentAttrName;
                        cmAtCtx.attrNameLower = currentAttrName.toLowerCase();
                        break;
                    }
                }
                this.atNameProvider.provide(cmAtCtx);
                break;
            }

            case TokenType.StartTag:
            case TokenType.StartTagOpen:
            case TokenType.Content:
            {
                this.suggestElements(cmCtx);
                break;
            }

            case TokenType.AttributeValue:
            {
                if (!node.stype) return;
                const arVal = tokenText.substring(1, tokenText.length - 1);
                const aOffset = offset - (scanner.getTokenOffset() + 1);

                if (isConstantValue(arVal)) {
                    this.provideConstants(items, getAttrValueKind(arVal));
                    break;
                }

                if (!node.stype) break;

                const cmAtCtx = <AtValComplContext>cmCtx;
                cmAtCtx.attrName = currentAttrName;
                cmAtCtx.attrNameLower = currentAttrName.toLowerCase();
                cmAtCtx.attrValue = arVal;
                cmAtCtx.atOffsetRelative = aOffset;
                this.atValueProvider.provide(cmAtCtx);

                break;
            }
        }

        return {
            items: cmCtx.citems,
        };
    }
}
