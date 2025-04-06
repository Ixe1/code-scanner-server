#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fg from "fast-glob";
// Standardized on async filesystem operations for better performance
import fs from "fs/promises";
import path from "path";
import { findUp } from "find-up";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { create } from "xmlbuilder2";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";
import Php from "tree-sitter-php";
import Css from "tree-sitter-css";
import Python from "tree-sitter-python"; // Added for Python support
import yargs from "yargs"; // Added
import { hideBin } from "yargs/helpers"; // Added

// --- Tree-sitter Setup ---
const parser = new Parser();

// Helper function to standardize the Tree-sitter language type casting
function castToParserLanguage(lang: any): Parser.Language {
	return lang as unknown as Parser.Language;
}

const languageMap: { [ext: string]: Parser.Language } = {
	".js": castToParserLanguage(JavaScript),
	".jsx": castToParserLanguage(JavaScript),
	".ts": castToParserLanguage(TypeScript.typescript),
	".tsx": castToParserLanguage(TypeScript.tsx),
	".cs": castToParserLanguage(CSharp),
	".php": castToParserLanguage(Php),
	".css": castToParserLanguage(Css),
	".py": castToParserLanguage(Python), // Added for Python support
};

// Basic queries - these can be expanded significantly
// Queries focused on namespace, class, method, function
const queries: { [langExt: string]: { [defType: string]: string } } = {
	".js": {
		function: `
			(function_declaration
				name: (identifier) @name
				parameters: (formal_parameters
					(formal_parameter
						name: (identifier) @param_name
						)*
				) @params
			) @function`,
		method: `
			(method_definition
				name: (property_identifier) @name
				parameters: (formal_parameters
					(formal_parameter
						name: (identifier) @param_name
						)*
				) @params
			) @method`,
		class: `(class_declaration name: (identifier) @name) @class`,
		variable: `
		    [
		      (lexical_declaration (variable_declarator name: (identifier) @name value: (_)? @value))
		      (variable_declaration (variable_declarator name: (identifier) @name value: (_)? @value))
		    ] @variable`,
		property: `(public_field_definition name: (property_identifier) @name value: (_)? @value) @property`,
		// JS doesn't have native enums in the same way TS/C#/PHP do
		enum: ``,
		enumMember: ``,
		call: `(call_expression function: [ (identifier) @call_name (member_expression property: (property_identifier) @call_name) ] ) @call`,
	},
	".ts": {
		function: `(function_declaration name: (_) @name) @function`,
		method: `(method_definition name: (_) @name) @method`,
		class: `(class_declaration name: (_) @name) @class`,
		interface: `(interface_declaration name: (_) @name) @interface`,
		variable: `
		    [
		      (lexical_declaration (variable_declarator name: (identifier) @name type: (_)? @dataType value: (_)? @value))
		      (variable_declaration (variable_declarator name: (identifier) @name type: (_)? @dataType value: (_)? @value))
		    ] @variable`,
		property: `
		    [
		      (property_signature name: (property_identifier) @name type: (_) @dataType) ;; Interface/Type Property
		      (public_field_definition name: (property_identifier) @name type: (_)? @dataType value: (_)? @value) ;; Class Field
		    ] @property`,
		enum: `(enum_declaration name: (identifier) @name) @enum`,
		enumMember: `(enum_assignment name: (property_identifier) @name value: (_)? @value) @enumMember`,
		// Refined call query for TypeScript to capture more cases
		call: `
		  (call_expression
		    function: [
		      (identifier) @call_name ;; Direct function call: myFunc()
		      (member_expression property: (property_identifier) @call_name) ;; Member call: obj.method(), console.log()
		      (super) @call_name ;; super() call
		      (non_null_expression expression: (member_expression property: (property_identifier) @call_name)) ;; Optional chaining call: obj?.method()
		    ]
		  ) @call`,
	},
	".cs": {
		class: `(class_declaration (modifier)* @modifier name: (identifier) @name) @class`,
		method: `(method_declaration (modifier)* @modifier name: (identifier) @name) @method`,
		namespace: `(namespace_declaration name: (_) @name) @namespace`,
		variable: `
		    (local_declaration_statement
		      (variable_declaration
		        type: (_) @dataType
		        (variable_declarator identifier: (identifier) @name (= (equals_value_clause value: (_) @value))?)
		      )
		    ) @variable`,
		property: `(field_declaration (modifier)* @modifier (variable_declaration type: (_) @dataType (variable_declarator (identifier) @name))) @property`, // Reverted to working version (no value)
		enum: `(enum_declaration (modifier)* @modifier name: (identifier) @name) @enum`,
		enumMember: `(enum_member_declaration name: (identifier) @name (= (equals_value_clause value: (_) @value))?) @enumMember`,
		call: `(invocation_expression expression: [ (identifier_name) @call_name (member_access_expression name: (identifier_name) @call_name) ] ) @call`,
	},
	".php": {
		function: `
			(function_definition
				(visibility_modifier)? @modifier
				return_type: (_)? @return_type
				name: (name) @name
				parameters: (formal_parameters
					(parameter_declaration
						type: (_)? @param_type
						name: (variable_name) @param_name
					)*
				)? @params
			) @function`,
		class: `(class_declaration (modifier)* @modifier name: (name) @name) @class`,
		method: `
			(method_declaration
				(member_modifier)* @modifier
				function_definition
					return_type: (_)? @return_type
					name: (name) @name
					parameters: (formal_parameters
						(parameter_declaration
							type: (_)? @param_type
							name: (variable_name) @param_name
						)*
					)? @params
				) @method`,
		namespace: `(namespace_definition name: (namespace_name) @name) @namespace`,
		// PHP local variables are complex to capture reliably with Tree-sitter without excessive noise
		variable: ``,
		property: `
		    (property_declaration
		      (member_modifier)* @modifier
		      type: (_)? @dataType
		      (property_element name: (variable_name) @name value: (_)? @value)
		    ) @property`,
		enum: `(enum_declaration name: (name) @name) @enum`, // PHP 8.1+
		enumMember: `(enum_case name: (name) @name value: (_)? @value) @enumMember`, // PHP 8.1+
		call: `(function_call_expression function: [ (name) @call_name (qualified_name) @call_name ] ) @call`,
		// Also consider method calls: (member_call_expression name: (name) @call_name)
	},
	// CSS queries removed as they don't fit namespace/class/method/function
	".css": {},
	".py": { // Added for Python support
		function: `
			(function_definition
			  name: (identifier) @name
			  parameters: (parameters . (_)* @params)? ;; Captures params block
			) @function`,
		// Note: This query captures all functions. Differentiating methods (functions inside classes)
		// would typically require checking the parent node during parsing logic.
		method: `
			(function_definition
			  name: (identifier) @name
			  parameters: (parameters . (_)* @params)?
			) @method`,
		class: `(class_definition name: (identifier) @name) @class`,
		decorator: `(decorator [ (identifier) @name (dotted_name) @name ]) @decorator`,
		// Captures module-level assignments and simple class-level assignments
		variable: `
			[
			  (module (expression_statement (assignment left: (identifier) @name right: (_) @value)))
			  (class_definition body: (block (expression_statement (assignment left: (identifier) @name right: (_) @value))))
			] @variable`,
		// Query for individual parameters if needed later:
		// parameter: `(parameters (typed_parameter name: (identifier) @name type: (_)? @type)) @parameter`
		call: `(call function: [ (identifier) @call_name (attribute name: (identifier) @call_name) ] ) @call`,
	},
};

// Default file patterns
const defaultFilePatterns = [
	"**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx",
	"**/*.cs", "**/*.php", "**/*.css",
	"**/*.py" // Added for Python support
];

// --- Helper Functions ---

// Helper function to escape special characters in regex patterns
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

async function findGitignore(startDir: string): Promise<string | undefined> {
	return findUp(".gitignore", { cwd: startDir });
}

async function getIgnoreFilter(
	gitignorePath: string | undefined
): Promise<(filePath: string) => boolean> {
	const ig = ignore();
	if (gitignorePath) {
		try {
			const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
			ig.add(gitignoreContent);
		} catch (err) {
			console.warn(`Warning: Could not read .gitignore at ${gitignorePath}`);
		}
	}
	// Always ignore node_modules and .git directories
	ig.add("node_modules/"); // Add trailing slash for directory
	ig.add(".git/");       // Add trailing slash for directory
	return (filePath: string) => !ig.ignores(filePath);
}
// Removed findFilesRecursively function


interface Parameter {
	name: string;
	type?: string;
}

interface Definition {
	id?: string; // Unique identifier
	type: string;
	name: string;
	startLine: number;
	endLine: number;
	modifier?: string;
	dataType?: string;
	value?: string;
	parentId?: string; // Reference to parent element
	children?: string[]; // Array of child element IDs
	parameters?: Parameter[]; // Method/function parameters
	returnType?: string; // Return type for methods/functions
	complexity?: number; // Cyclomatic complexity (optional)
	parameterCount?: number; // Number of parameters (optional)
	loc?: number; // Lines of Code (optional)
	calls?: string[]; // Array of names called by this definition (optional)
}

interface FilterOptions {
	includeTypes?: string[]; // Element types to include (e.g., 'class', 'method')
	excludeTypes?: string[]; // Element types to exclude
	includeModifiers?: string[]; // Modifiers to include (e.g., 'public', 'private')
	excludeModifiers?: string[]; // Modifiers to exclude
	namePattern?: string; // Regex pattern to match element names
	excludeNamePattern?: string; // Regex pattern to exclude element names
	includePaths?: string[]; // Additional file path patterns to include
	excludePaths?: string[]; // File path patterns to exclude
	// Metric filters
	maxComplexity?: number;
	minComplexity?: number;
	maxParameters?: number;
	minParameters?: number;
}

// Helper function for basic Cyclomatic Complexity calculation
function calculateComplexity(node: Parser.SyntaxNode | null): number {
	if (!node) return 1; // Base complexity

	let complexity = 1; // Start with 1 for the single entry point

	// List of node types that represent decision points (can be expanded)
	const decisionPointTypes = new Set([
		// Common
		'if_statement', 'while_statement', 'for_statement', 'for_in_statement',
		'switch_case', 'case_statement', 'switch_default', // Switch parts
		'conditional_expression', // ternary operator
		'binary_expression', // Often includes &&, || - check operator if needed
		'boolean_operator', // Python 'and', 'or'
		'catch_clause', // Try-catch adds a path
		// Language Specific (Examples)
		'foreach_statement', // C#, PHP
		'case_clause', // Python match-case
	]);

	// Recursive traversal
	function traverse(currentNode: Parser.SyntaxNode) {
		if (decisionPointTypes.has(currentNode.type)) {
			// More specific check for binary expressions (&&, ||) if needed
			if (currentNode.type === 'binary_expression' || currentNode.type === 'boolean_operator') {
				const operator = currentNode.childForFieldName?.('operator')?.text; // Adjust field name if needed
				if (operator === '&&' || operator === '||' || operator === 'and' || operator === 'or') {
					complexity++;
				}
			} else {
				complexity++;
			}
		}
		// Recurse into children
		for (const child of currentNode.children) {
			traverse(child);
		}
	}

	traverse(node);
	return complexity;
}


function parseCodeWithTreeSitter(
	code: string,
	filePath: string
): Definition[] {
	const definitions: Definition[] = [];
	const fileExt = path.extname(filePath).toLowerCase();
	const language = languageMap[fileExt];

	if (!language) {
		return [{ type: "error", name: "Unsupported file type", startLine: 0, endLine: 0 }];
	}

	parser.setLanguage(language);
	let tree: Parser.Tree;
	try {
		tree = parser.parse(code);
	} catch (error: any) {
		// Use absolute paths for reliable comparison
		const absoluteFilePath = path.resolve(filePath);
		const absoluteTargetFilePath = path.resolve("src/index.ts"); // Resolve relative to CWD
		const errorLogPath = path.join(process.cwd(), "parser-error.log"); // Log in CWD

		if (absoluteFilePath === absoluteTargetFilePath) {
			const errorMessage = `ERROR: Tree-sitter failed to parse ${filePath} at ${new Date().toISOString()}.\nFull error:\n${JSON.stringify(error, null, 2)}\n---\n`;
			// Log the error asynchronously, but don't block parsing
			fs.appendFile(errorLogPath, errorMessage)
				.then(() => console.error(`ERROR: Tree-sitter failed to parse ${filePath}. See ${errorLogPath} for details.`))
				.catch(logErr => console.error(`FATAL: Failed to write to ${errorLogPath}: ${logErr.message}`));
			
			// Return a specific error definition to indicate parsing failure for this critical file
			return [{ type: "error", name: `Failed to parse self (${filePath})`, startLine: 0, endLine: 0 }];
		} else {
			// For other files, just log the error and return an empty array
			console.error(`Error parsing ${filePath}:`, error);
			return [{ type: "error", name: `Failed to parse ${filePath}`, startLine: 0, endLine: 0 }];
		}
	}

	const langQueries = queries[fileExt];
	if (!langQueries) {
		return [{ type: "error", name: "No queries defined for file type", startLine: 0, endLine: 0 }];
	}

	// Generate unique IDs
	let idCounter = 0;
	const generateId = () => `def-${idCounter++}`;

	for (const defType in langQueries) {
		const queryStr = langQueries[defType];
		if (!queryStr) continue; // Skip empty queries (like CSS or JS enums)

		try {
			const query = new Parser.Query(language, queryStr);
			const matches = query.matches(tree.rootNode);

			for (const match of matches) {
				const nameNode = match.captures.find((c: Parser.QueryCapture) => c.name === "name")?.node;
				const modifierNode = match.captures.find((c: Parser.QueryCapture) => c.name === "modifier")?.node;
				const definitionNode = match.captures.find((c: Parser.QueryCapture) => c.name === defType)?.node; // Use defType capture
				if (!nameNode || !definitionNode) continue;

				// Capture optional fields
				const dataTypeNode = match.captures.find((c: Parser.QueryCapture) => c.name === "dataType")?.node;
				const valueNode = match.captures.find((c: Parser.QueryCapture) => c.name === "value")?.node;
				const returnTypeNode = match.captures.find((c: Parser.QueryCapture) => c.name === "return_type")?.node;
				const paramsNode = match.captures.find((c: Parser.QueryCapture) => c.name === "params")?.node; // Capture params block

				// Determine parent type based on language and definition type
				let parentType: string | undefined;
				const localScopeTypes = ['variable', 'local_variable']; // Types typically defined within functions/methods

				// Parent type is determined later by the tree traversal approach
				// Local scope types don't need special handling since we use node traversal

				const definition: Definition = {
					id: generateId(),
					type: defType,
					name: nameNode.text,
					startLine: definitionNode.startPosition.row + 1,
					endLine: definitionNode.endPosition.row + 1,
					loc: definitionNode.endPosition.row - definitionNode.startPosition.row + 1, // Calculate LoC
					modifier: modifierNode?.text,
					dataType: dataTypeNode?.text,
					value: valueNode?.text,
					returnType: returnTypeNode?.text,
					children: [], // Initialize children array
					// Initialize metrics - parameterCount and complexity calculated later
					parameterCount: 0,
					complexity: 1,
				};

				// Extract signature for methods/functions if possible
				if (['method', 'function'].includes(defType)) {
					// Calculate complexity for functions/methods
					definition.complexity = calculateComplexity(definitionNode); // Calculate Complexity

					// Attempt to get the full signature text
					const startPos = definitionNode.startPosition;
					const endPos = definitionNode.endPosition;
					const sourceLines = code.split('\n');

					// Heuristic: Try to capture the signature line(s)
					// This might need refinement based on language specifics
					let signature = '';
					if (startPos.row === endPos.row) {
						signature = sourceLines[startPos.row].substring(startPos.column, endPos.column);
					} else {
						// Multi-line signature (less common for just the signature part)
						// Try to capture up to the opening brace '{' or equivalent
						const openingBraceIndex = definitionNode.text.indexOf('{');
						signature = openingBraceIndex > -1 ? definitionNode.text.substring(0, openingBraceIndex).trim() : definitionNode.text.split('\n')[0].trim();
					}
					// Clean up signature (optional)
					signature = signature.replace(/\s+/g, ' ').trim();
					// definition.signature = signature; // Add if needed later

					// Extract parameters if paramsNode exists
					if (paramsNode) {
						const parameters: Parameter[] = [];
						const paramCaptures = query.captures(paramsNode); // Query within the params node

						// Find parameter names and types (adjust query capture names as needed)
						let paramMatch: { name?: string, type?: string } = {};
						for (const capture of paramCaptures) {
							if (capture.name === 'param_name') {
								paramMatch.name = capture.node.text;
							} else if (capture.name === 'param_type') {
								paramMatch.type = capture.node.text;
							}

							// When we have a name, add the parameter and reset
							if (paramMatch.name) {
								parameters.push({ name: paramMatch.name, type: paramMatch.type });
								paramMatch = {}; // Reset for the next parameter
							}
						}
						// Fallback: If captures don't work well, parse the text directly (less robust)
						if (parameters.length === 0 && paramsNode.text.length > 2) { // Avoid empty "()"
							const paramList = paramsNode.text.slice(1, -1).split(','); // Remove () and split
							parameters.push(...paramList.map((p: string) => {
								const trimmed = p.trim();
								// Basic type inference (example for TS/PHP like syntax)
								const typeMatch = trimmed.match(/^(\S+)\s+(\$\S+|\S+)/); // e.g., "string $name" or "int count"
								if (typeMatch) {
									return { name: typeMatch[2], type: typeMatch[1] };
								}
								return { name: trimmed }; // Just name if no type found
							}).filter((p: { name: string; type?: string; }) => p.name)); // Filter out empty params
						}


						definition.parameters = parameters;
						definition.parameterCount = parameters.length; // Calculate Parameter Count

						// Find calls within this function/method body
						const callQueryStr = langQueries['call'];
						if (callQueryStr) {
							try {
								const callQuery = new Parser.Query(language, callQueryStr);
								const callMatches = callQuery.matches(definitionNode); // Search within the definition node
								const calledNames = new Set<string>(); // Use Set to avoid duplicates

								for (const callMatch of callMatches) {
									const callNameNode = callMatch.captures.find((c: Parser.QueryCapture) => c.name === "call_name")?.node;
									if (callNameNode) {
										calledNames.add(callNameNode.text);
									}
								}
								if (calledNames.size > 0) {
									definition.calls = Array.from(calledNames);
								}
							} catch (callQueryError: any) {
								console.warn(`Warning: Failed to execute call query for ${defType} ${definition.name} in ${filePath}:`, callQueryError.message);
							}
						}
					}

					// Extract return type if returnTypeNode exists
					if (returnTypeNode) {
						definition.returnType = returnTypeNode.text;
					} else {
						// Fallback: Try to capture from signature text (language-specific)
						// Example for PHP/TS style: function getName(): string { ... }
						const returnTypeMatch = signature.match(/:\s*(\w+)\s*\{?$/);
						if (returnTypeMatch) {
							definition.returnType = returnTypeMatch[1];
						}
					}
				}


				definitions.push(definition);
			}
		} catch (queryError: any) {
			console.error(`Error executing query for ${defType} in ${filePath}:`, queryError);
			// Continue to next definition type
		}
	}

	// --- Parent-Child Relationship Logic ---
	// Create a map for quick lookup by ID
	const definitionMap = new Map(definitions.map(def => [def.id, def]));

	definitions.forEach(def => {
		const node = tree.rootNode.descendantForPosition({ row: def.startLine - 1, column: 0 }); // Get node at start line
		if (node) {
			// No redundant parent-child relationship logic (removed)


			// More robust parent finding: traverse up the syntax tree
			let potentialParentNode = node.parent;
			let parent: Definition | undefined = undefined;
			while (potentialParentNode) {
				parent = definitions.find(p =>
					p.id !== def.id &&
					p.startLine === potentialParentNode!.startPosition.row + 1 &&
					p.endLine === potentialParentNode!.endPosition.row + 1 &&
					['class', 'namespace', 'interface', 'enum', 'method', 'function'].includes(p.type) // Plausible parent types
				);
				if (parent) break; // Found a direct parent definition
				potentialParentNode = potentialParentNode.parent;
			}


			if (parent) {
				def.parentId = parent.id;
				if (!parent.children) {
					parent.children = [];
				}
				if (def.id) { // Ensure def.id is defined before pushing
					parent.children.push(def.id);
				}
			}
		}
	});


	return definitions;
}

// Helper to find the type of the nearest enclosing definition
// The findParentType function was removed as it was an unimplemented placeholder
// and the parent-child relationship is now handled by the tree traversal approach


// --- Filtering Logic --- Refactored
// applyFilters function removed - use applyFiltersToDefinitions directly


// --- XML Formatting ---
function formatResultsXML(
	results: { [filePath: string]: Definition[] },
	detailLevel: 'minimal' | 'standard' | 'detailed'
): string {
	const root = create({ version: "1.0", encoding: "UTF-8" }).ele("CodeScanResults");

	// Helper function to recursively add definitions
	function renderDefinition(def: Definition, definitions: Definition[], parentElement: any): void {
		// Base attributes for all levels
		const attrs: { [key: string]: any } = {
			type: def.type,
			name: def.name,
		};

		if (detailLevel !== 'minimal') {
			attrs.startLine = def.startLine;
			attrs.endLine = def.endLine;
			if (def.modifier) attrs.modifier = def.modifier;
		}

		if (detailLevel === 'detailed') {
			if (def.dataType) attrs.dataType = def.dataType;
			if (def.value && def.type !== 'variable' && def.type !== 'property') {
				attrs.value = def.value;
			}
			if (def.returnType) attrs.returnType = def.returnType;
			// Add metrics
			// if (def.loc !== undefined) attrs.loc = def.loc; // Removed as requested
			// if (def.parameterCount !== undefined) attrs.parameterCount = def.parameterCount; // Removed as requested
			// if (def.complexity !== undefined) attrs.complexity = def.complexity; // Removed as requested
			// Parameters are handled separately below
		}

		const defEle = parentElement.ele("Definition", attrs);

		// Add parameters for detailed level
		if (detailLevel === 'detailed' && def.parameters && def.parameters.length > 0) {
			const paramsEle = defEle.ele("Parameters");
			def.parameters.forEach((param: Parameter) => {
				const paramAttrs: { [key: string]: any } = { name: param.name };
				if (param.type) paramAttrs.type = param.type;
				paramsEle.ele("Parameter", paramAttrs);
			});
		}

		// Add calls for detailed level
		if (detailLevel === 'detailed' && def.calls && def.calls.length > 0) {
			const callsEle = defEle.ele("Calls");
			def.calls.forEach((callName: string) => {
				callsEle.ele("Call", { name: callName });
			});
		}


		// Recursively add children if they exist
		if (def.children && def.children.length > 0) {
			def.children.forEach((childId) => {
				const child = definitions.find((d) => d.id === childId);
				if (child) {
					renderDefinition(child, definitions, defEle); // Pass defEle as the new parent
				}
			});
		}
	}


	for (const filePath in results) {
		const fileEle = root.ele("File", { path: filePath });
		const definitions = results[filePath];
		// Filter for top-level definitions (no parentId) to start the hierarchy
		const topLevelDefs = definitions.filter(def => !def.parentId);
		topLevelDefs.forEach((def) => {
			renderDefinition(def, definitions, fileEle); // Pass fileEle as the initial parent
		});
	}

	return root.end({ prettyPrint: true });
}

// --- Markdown Formatting ---
function formatResultsMarkdown(
	results: { [filePath: string]: Definition[] },
	detailLevel: 'minimal' | 'standard' | 'detailed',
	directoryPath: string // Added directory path for relative file paths
): string {
	let md = `# Code Scan Results for ${directoryPath}\n\n`; // Use provided directory path

	// Helper function to recursively render definitions
	function renderDefinition(def: Definition, definitions: Definition[], indent: number = 0): string {
		const indentation = "  ".repeat(indent); // Two spaces per indent level
		let result = "";

		// Determine output based on detail level
		switch (detailLevel) {
			case 'minimal':
				// Minimal: Type: Name
				result = `${indentation}- **${def.type.toUpperCase()}**: \`${def.name}\``;
				break;
			case 'standard':
			default:
				// Standard: Type: Name (Lines: Start-End) [Modifier]
				const lineInfo = `(Lines: ${def.startLine}-${def.endLine})`;
				const modifierText = def.modifier ? ` [\`${def.modifier}\`]` : "";
				result = `${indentation}- **${def.type.toUpperCase()}**: \`${def.name}\` ${lineInfo}${modifierText}`;
				break;
			case 'detailed':
				// Detailed: Type: Name (Lines: Start-End) [Modifier] {Details}
				const detailedLineInfo = `(Lines: ${def.startLine}-${def.endLine})`;
				const detailedModifierText = def.modifier ? ` [\`${def.modifier}\`]` : "";
				let details = [];
				if (def.dataType) details.push(`DataType: \`${def.dataType}\``);
				if (def.value && def.type !== 'variable' && def.type !== 'property') details.push(`Value: \`${def.value.substring(0, 50)}${def.value.length > 50 ? '...' : ''}\``);
				if (def.parameters && def.parameters.length > 0) {
					const paramText = def.parameters.map(p => `\`${p.name}${p.type ? `: ${p.type}` : ''}\``).join(', ');
					details.push(`Params: ${paramText}`);
				}
				if (def.returnType) details.push(`Returns: \`${def.returnType}\``);
				// Add metrics
				// if (def.loc !== undefined) details.push(`LoC: ${def.loc}`); // Removed as requested
				// if (def.parameterCount !== undefined) details.push(`Param Count: ${def.parameterCount}`); // Removed as requested
				// if (def.complexity !== undefined) details.push(`Complexity: ${def.complexity}`); // Removed as requested
				// Add calls
				if (def.calls && def.calls.length > 0) {
					details.push(`Calls: \`${def.calls.join('`, `')}\``);
				}

				const detailText = details.length > 0 ? ` { ${details.join('; ')} }` : "";
				result = `${indentation}- **${def.type.toUpperCase()}**: \`${def.name}\` ${detailedLineInfo}${detailedModifierText}${detailText}`;
				break;
		}


		result += "\n";

		// Recursively add children
		if (def.children && def.children.length > 0) {
			def.children.forEach((childId) => {
				const child = definitions.find((d) => d.id === childId);
				if (child) {
					result += renderDefinition(child, definitions, indent + 1);
				}
			});
		}
		return result;
	}

	const filePaths = Object.keys(results).sort(); // Sort file paths for consistent output

	for (const filePath of filePaths) {
		// Use relative path from the scanned directory
		const relativeFilePath = path.relative(directoryPath, filePath).replace(/\\/g, '/'); // Normalize path separators
		md += `## File: \`${relativeFilePath}\`\n\n`; // Use relative path
		const definitions = results[filePath];
		// Filter for top-level definitions (no parentId) to start the hierarchy
		const topLevelDefs = definitions.filter(def => !def.parentId);

		if (topLevelDefs.length === 0 && definitions.length > 0) {
			// Handle cases where all definitions might be children (e.g., only methods in a class)
			// This part might need refinement depending on desired output for such cases.
			// For now, just list all if no top-level are found.
			// definitions.forEach(def => {
			// 	md += renderDefinition(def, definitions, 0);
			// });
			// Alternative: Indicate no top-level definitions found explicitly?
			md += `  *(No top-level definitions found, listing all)*\n`;
			definitions.forEach(def => { md += renderDefinition(def, definitions, 1); });


		} else {
			topLevelDefs.forEach((def) => {
				md += renderDefinition(def, definitions, 0);
			});
		}
		md += "\n"; // Add space between files
	}

	// Add metadata section (optional, example)
	const metaEntries = results["metadata"] || []; // Assuming metadata might be stored under a special key
	if (metaEntries.length > 0) {
		md += `## Metadata\n\n`;
		metaEntries.forEach(meta => {
			md += `- **${meta.type}**: ${meta.name}\n`; // Adjust formatting as needed
		});
		md += "\n";
	}


	return md;
}

// --- JSON Formatting ---
function formatResultsJSON(
	results: { [filePath: string]: Definition[] },
	detailLevel: 'minimal' | 'standard' | 'detailed'
): string {
	const output: { [filePath: string]: any[] } = {};

	// Helper function to create a JSON object for a definition based on detail level
	function createDefinitionObject(def: Definition, allDefs: Definition[]): any {
		const baseObj: any = {
			type: def.type,
			name: def.name,
		};

		if (detailLevel === 'minimal') {
			return baseObj; // Only type and name for minimal
		}

		// Standard and Detailed include lines
		baseObj.startLine = def.startLine;
		baseObj.endLine = def.endLine;

		if (def.modifier) baseObj.modifier = def.modifier;

		if (detailLevel === 'detailed') {
			// Detailed includes everything
			if (def.dataType) baseObj.dataType = def.dataType;
			if (def.value && def.type !== 'variable' && def.type !== 'property') baseObj.value = def.value;
			if (def.parameters && def.parameters.length > 0) baseObj.parameters = def.parameters;
			if (def.returnType) baseObj.returnType = def.returnType;
			// Add metrics for detailed level
			// if (def.loc !== undefined) baseObj.loc = def.loc; // Removed as requested
			// if (def.parameterCount !== undefined) baseObj.parameterCount = def.parameterCount; // Removed as requested
			// if (def.complexity !== undefined) baseObj.complexity = def.complexity; // Removed as requested
			// Add calls for detailed level
			if (def.calls && def.calls.length > 0) baseObj.calls = def.calls;
		}

		// Add children recursively for standard and detailed
		if (def.children && def.children.length > 0) {
			baseObj.children = def.children
				.map(childId => allDefs.find(d => d.id === childId))
				.filter((child): child is Definition => !!child) // Type guard
				.map(child => createDefinitionObject(child, allDefs)); // Recursive call
		}

		return baseObj;
	}

	for (const filePath in results) {
		const definitions = results[filePath];
		// Filter for top-level definitions (no parentId) to start the hierarchy
		const topLevelDefs = definitions.filter(def => !def.parentId);
		output[filePath] = topLevelDefs.map(def => createDefinitionObject(def, definitions));
	}

	return JSON.stringify(output, null, 2); // Pretty print JSON
}


// --- Core Scanning Logic --- Refactored
async function performScan(
	directory: string,
	filePatterns: string[],
	outputFormat: 'xml' | 'markdown' | 'json',
	detailLevel: 'minimal' | 'standard' | 'detailed' = 'standard',
	filterOptions: FilterOptions = {}
): Promise<string> {
	const startTime = Date.now();
	console.error(`Starting scan in directory: ${directory}`);
	console.error(`File patterns: ${filePatterns.join(', ')}`);
	console.error(`Output format: ${outputFormat}, Detail level: ${detailLevel}`);
	console.error(`Filter options: ${JSON.stringify(filterOptions)}`);


	// Resolve the target directory relative to the current working directory
	const targetDir = path.resolve(process.cwd(), directory);
	console.error(`Resolved target directory: ${targetDir}`);

	try {
		// Check if the directory exists using async fs
		await fs.access(targetDir);
	} catch (error) {
		throw new Error(`Directory not found: ${targetDir}`);
	}

	// Find .gitignore
	const gitignorePath = await findGitignore(targetDir);
	const ignoreFilter = await getIgnoreFilter(gitignorePath);
	console.error(`Using .gitignore: ${gitignorePath || 'None found'}`);


	// --- File Discovery ---
	console.error("Starting file discovery...");
	let files: Set<string>; // Declare files set here

	// Check if includePaths is provided and should be restrictive
	if (filterOptions.includePaths && filterOptions.includePaths.length > 0) {
		console.error("`includePaths` provided, operating in restrictive mode.");
		files = new Set<string>(); // Initialize as empty set

		// Process only the paths specified in includePaths
		for (const includePath of filterOptions.includePaths) {
			// Handle potential glob patterns within includePaths if necessary,
			// or treat them as specific files/directories.
			// Current logic reuses the file/directory handling from below.
			const absoluteIncludePath = path.resolve(targetDir, includePath);
			try {
				const stats = await fs.stat(absoluteIncludePath);
				if (stats.isFile()) {
					files.add(path.normalize(absoluteIncludePath));
					console.error(`Added specific file from includePaths: ${absoluteIncludePath}`);
				} else if (stats.isDirectory()) {
					console.error(`Included path is a directory, scanning recursively: ${absoluteIncludePath}`);
					// Use fg to find files within the directory, respecting basic ignores
					const dirFiles = await fg(path.join(absoluteIncludePath, '**/*').replace(/\\/g, '/'), {
						dot: true,
						onlyFiles: true,
						absolute: true,
						ignore: ['**/node_modules/**', '**/.git/**'], // Consistent ignores
					});
					dirFiles.forEach(f => files.add(path.normalize(f)));
					console.error(`Added ${dirFiles.length} files from included directory: ${absoluteIncludePath}`);
				}
			} catch (statError: any) {
				// Handle cases where includePath might be a glob pattern needing fg
				if (includePath.includes('*') || includePath.includes('?')) {
					console.error(`Included path looks like a glob, attempting glob match: ${includePath}`);
					try {
						const globMatches = await fg(path.join(targetDir, includePath).replace(/\\/g, '/'), {
							dot: true, onlyFiles: true, absolute: true, cwd: targetDir,
							ignore: ['**/node_modules/**', '**/.git/**'],
						});
						globMatches.forEach(match => files.add(path.normalize(match)));
						console.error(`Added ${globMatches.length} files from includePaths glob: ${includePath}`);
					} catch (globError) {
						console.error(`Error matching includePaths glob ${includePath}:`, globError);
					}
				} else if (statError.code === 'ENOENT') {
					console.warn(`Warning: Included path not found: ${absoluteIncludePath}`);
				} else {
					console.error(`Error processing included path ${absoluteIncludePath}:`, statError);
				}
			}
		}
		console.error(`Total files after processing restrictive includePaths: ${files.size}`);

	} else {
		// --- Standard File Discovery using filePatterns (glob) ---
		console.error("No restrictive `includePaths`, using standard `filePatterns` globbing.");
		const globMatchedFiles = new Set<string>(); // Store absolute paths from glob matching

		// Combine default and provided patterns if necessary
		const combinedPatterns = [...new Set(filePatterns)];
		console.error(`Combined glob patterns for search: ${combinedPatterns.join(', ')}`);

		// Execute glob patterns relative to the target directory
		const globPatterns = combinedPatterns.map(p => path.join(targetDir, p).replace(/\\/g, '/'));
		console.error(`Absolute glob patterns for fast-glob: ${globPatterns.join(', ')}`);

		try {
			const globMatches = await fg(globPatterns, {
				dot: true, onlyFiles: true, absolute: true, cwd: targetDir,
				ignore: ['**/node_modules/**', '**/.git/**'],
			});
			console.error(`fast-glob matched ${globMatches.length} files initially.`);
			globMatches.forEach(match => globMatchedFiles.add(path.normalize(match)));
		} catch (globError) {
			console.error("Error during fast-glob execution:", globError);
			throw new Error("File globbing failed.");
		}

		files = new Set<string>(globMatchedFiles); // Start with glob results

		// --- Include specific non-glob paths (additive) ---
		// This part only runs if includePaths was NOT restrictive
		const nonGlobIncludes = filterOptions.includePaths?.filter(p => !p.includes('*') && !p.includes('?')) || [];
		if (nonGlobIncludes.length > 0) {
			console.error("Adding specific non-glob paths from `includePaths`...");
			for (const includePath of nonGlobIncludes) {
				const absoluteIncludePath = path.resolve(targetDir, includePath);
				try {
					const stats = await fs.stat(absoluteIncludePath);
					if (stats.isFile()) {
						files.add(path.normalize(absoluteIncludePath));
						console.error(`Added specific file from includePaths: ${absoluteIncludePath}`);
					} else if (stats.isDirectory()) {
						console.error(`Included path is a directory, scanning recursively: ${absoluteIncludePath}`);
						const dirFiles = await fg(path.join(absoluteIncludePath, '**/*').replace(/\\/g, '/'), {
							dot: true, onlyFiles: true, absolute: true,
							ignore: ['**/node_modules/**', '**/.git/**'],
						});
						dirFiles.forEach(f => files.add(path.normalize(f)));
						console.error(`Added ${dirFiles.length} files from included directory: ${absoluteIncludePath}`);
					}
				} catch (statError: any) {
					if (statError.code === 'ENOENT') {
						console.warn(`Warning: Included path not found: ${absoluteIncludePath}`);
					} else {
						console.error(`Error stating included path ${absoluteIncludePath}:`, statError);
					}
				}
			}
		}
	}
	// --- End of Conditional File Discovery ---

	// --- Include specific non-glob paths if provided --- // This section title is now misleading, the logic is handled above. Remove/adjust comment.
	// const files = new Set<string>(globMatchedFiles); // This line is now inside the else block
	// The logic previously here (lines 883-911) has been integrated into the
	// conditional blocks above (restrictive 'if' and standard 'else')
	// to handle includePaths correctly in both scenarios.


	// --- Filtering based on .gitignore and excludePaths ---
	let filesToFilter = Array.from(files);
	console.error(`Total files before gitignore/exclude filtering: ${filesToFilter.length}`);


	// 1. Apply .gitignore filter
    filesToFilter = filesToFilter.filter(absPath => {
        const relativePath = path.relative(targetDir, absPath).replace(/\\/g, '/'); // Relative path for ignore check
        return ignoreFilter(relativePath);
    });
	console.error(`Files after gitignore filtering: ${filesToFilter.length}`);


	// 2. Apply excludePaths filter (using minimatch)
    const excludePatterns = filterOptions.excludePaths || [];
    if (excludePatterns.length > 0) {
        console.error(`Applying excludePaths patterns: ${excludePatterns.join(', ')}`);
        const filteredFiles = filesToFilter.filter((absPath) => {
            const relativePath = path.relative(targetDir, absPath).replace(/\\/g, '/');
            // Check if the relative path matches any exclude pattern
            const isExcluded = excludePatterns.some(pattern => minimatch(relativePath, pattern, { dot: true }));
            if (isExcluded) {
                // console.error(`Excluding file due to pattern '${excludePatterns.find(p => minimatch(relativePath, p))}': ${relativePath}`);
            }
            return !isExcluded; // Keep if not excluded
        });
		const excludedCount = filesToFilter.length - filteredFiles.length;
		if (excludedCount > 0) {
			console.error(`Excluded ${excludedCount} files based on excludePaths patterns.`);
		}
        filesToFilter = filteredFiles;
    }
	console.error(`Files after excludePaths filtering: ${filesToFilter.length}`);


	// --- Parsing and Definition Extraction ---
	const results: { [filePath: string]: Definition[] } = {};
	console.error(`Parsing ${filesToFilter.length} files...`);


	for (const absoluteFilePath of filesToFilter) {
		// Use relative path for keys in the results object for cleaner output
		const relativePath = path.relative(targetDir, absoluteFilePath).replace(/\\/g, '/'); // Use forward slashes
		try {
			const content = await fs.readFile(absoluteFilePath, "utf-8");
			const definitions = parseCodeWithTreeSitter(content, absoluteFilePath); // Pass absolute path here
			if (definitions.length > 0) { // Only add files with definitions or errors
				results[absoluteFilePath] = definitions; // Store with absolute path initially
				// console.error(`Parsed ${relativePath}: Found ${definitions.length} potential definitions.`);
			} else {
				// console.error(`Parsed ${relativePath}: No definitions found.`);
			}
		} catch (error: any) {
			console.error(`Error reading or parsing file ${relativePath}:`, error.message);
			results[absoluteFilePath] = [{ type: "error", name: `Failed to read/parse: ${error.message}`, startLine: 0, endLine: 0 }];
		}
	}
	console.error("Finished parsing files.");


	// --- Filtering Definitions ---
	console.error("Applying definition filters...");
	const filteredResults: { [filePath: string]: Definition[] } = {};
	for (const absoluteFilePath in results) {
		const definitions = results[absoluteFilePath];
		const filteredDefs = applyFiltersToDefinitions(definitions, filterOptions);

		// Only include the file in the final results if it has non-error definitions after filtering
		const hasRealDefinitions = filteredDefs.some(def => def.type !== 'error');
		if (hasRealDefinitions) {
			const relativePath = path.relative(targetDir, absoluteFilePath).replace(/\\/g, '/');
			filteredResults[relativePath] = filteredDefs; // Use relative path for final output keys
			// console.error(`Filtered ${relativePath}: Kept ${filteredDefs.length} definitions.`);
		} else {
			// console.error(`Filtered ${relativePath}: No definitions kept.`);
		}
	}
	console.error("Finished applying definition filters.");


	// --- Formatting Output ---
	console.error(`Formatting results as ${outputFormat}...`);
	let outputText: string;
	switch (outputFormat) {
		case "xml":
			outputText = formatResultsXML(filteredResults, detailLevel);
			break;
		case "json":
			outputText = formatResultsJSON(filteredResults, detailLevel);
			break;
		case "markdown":
		default:
			// Pass the original directory path for relative path calculation in Markdown
			outputText = formatResultsMarkdown(filteredResults, detailLevel, directory);
			break;
	}
	console.error("Finished formatting results.");
	const endTime = Date.now();
	console.error(`Scan completed in ${endTime - startTime}ms.`);


	return outputText;
}


// --- Advanced Filtering Logic ---
// This function applies filters AND handles parent/child relationships correctly.
function applyFiltersToDefinitions(definitions: Definition[], filterOptions: FilterOptions): Definition[] {
	if (!definitions || definitions.length === 0) return [];

	// Make a deep copy to avoid modifying the original array during filtering
	const definitionsCopy: Definition[] = JSON.parse(JSON.stringify(definitions));

	// Separate metadata/error entries if they exist (assuming type 'error' or 'metadata')
	const metaEntries = definitionsCopy.filter(def => def.type === 'error' || def.type === 'metadata');
	const nonMetaEntries = definitionsCopy.filter(def => def.type !== 'error' && def.type !== 'metadata');

	// 1. Apply basic filters (type, modifier, name patterns) to non-meta entries
	const basicFilteredEntries = nonMetaEntries.filter(def => {
		// Type filtering
		if (filterOptions.includeTypes && filterOptions.includeTypes.length > 0 && !filterOptions.includeTypes.includes(def.type)) return false;
		if (filterOptions.excludeTypes && filterOptions.excludeTypes.length > 0 && filterOptions.excludeTypes.includes(def.type)) return false;

		// Modifier filtering
		// Handle cases where modifier might be multi-part (e.g., "public static")
		const defModifiers = def.modifier?.split(' ') || [];
		if (filterOptions.includeModifiers && filterOptions.includeModifiers.length > 0) {
			if (!def.modifier || !filterOptions.includeModifiers.some(incMod => defModifiers.includes(incMod))) return false;
		}
		if (filterOptions.excludeModifiers && filterOptions.excludeModifiers.length > 0) {
			if (def.modifier && filterOptions.excludeModifiers.some(exMod => defModifiers.includes(exMod))) return false;
		}


		// Name pattern filtering (apply to the core name without modifiers/types)
		if (filterOptions.namePattern) {
			try {
				const regex = new RegExp(filterOptions.namePattern);
				// Extract just the name part if modifiers/types are prepended (basic heuristic)
				const nameWithoutModifier = def.name.split(' ').pop() || def.name; // Get last part after spaces
				const fullName = def.name; // Keep full name for context if needed

				// Test against both the extracted name and the full name for flexibility
				if (!regex.test(nameWithoutModifier) && !regex.test(fullName)) return false;
			} catch (e) {
				console.warn(`Invalid regex for namePattern: ${filterOptions.namePattern}`);
				return false; // Exclude if regex is invalid
			}
		}
		if (filterOptions.excludeNamePattern) {
			try {
				const regex = new RegExp(filterOptions.excludeNamePattern);
				const nameWithoutModifier = def.name.split(' ').pop() || def.name;
				const fullName = def.name;
				if (regex.test(nameWithoutModifier) || regex.test(fullName)) return false;
			} catch (e) {
				console.warn(`Invalid regex for excludeNamePattern: ${filterOptions.excludeNamePattern}`);
				// Don't exclude if regex is invalid, maybe log it
			}
		}

		// Metric filtering (apply only if metric exists on definition)
		if (filterOptions.minComplexity !== undefined && (def.complexity === undefined || def.complexity < filterOptions.minComplexity)) return false;
		if (filterOptions.maxComplexity !== undefined && (def.complexity === undefined || def.complexity > filterOptions.maxComplexity)) return false;
		if (filterOptions.minParameters !== undefined && (def.parameterCount === undefined || def.parameterCount < filterOptions.minParameters)) return false;
		if (filterOptions.maxParameters !== undefined && (def.parameterCount === undefined || def.parameterCount > filterOptions.maxParameters)) return false;


		return true;
	});

	// 2. Build the initial set of IDs to include (basic filtered entries)
	const entriesToInclude = new Set(basicFilteredEntries.map(def => def.id));

	// 3. Add parents of included entries recursively
	// Use a Set to avoid infinite loops in case of cyclic dependencies (shouldn't happen)
	const processedForParents = new Set<string>();
	let itemsToAdd = [...basicFilteredEntries]; // Start with the initially filtered items

	while (itemsToAdd.length > 0) {
		const current = itemsToAdd.pop();
		if (!current || !current.id || processedForParents.has(current.id)) {
			continue; // Skip if no current item, no ID, or already processed
		}
		processedForParents.add(current.id);

		if (current.parentId && !entriesToInclude.has(current.parentId)) {
			const parent = definitionsCopy.find(p => p.id === current.parentId); // Find in the original copy
			if (parent && parent.id) {
				// Check if the parent itself should be excluded by name pattern
				if (filterOptions.excludeNamePattern) {
					try {
						const regex = new RegExp(filterOptions.excludeNamePattern);
						const nameWithoutModifier = parent.modifier ? parent.name.replace(new RegExp(`^${parent.modifier}\\s+`), '') : parent.name;
						const fullName = parent.name; // Use full name including modifier for matching
						if (regex.test(nameWithoutModifier) || regex.test(fullName)) {
							continue; // Skip adding this excluded parent and processing its parents
						}
					} catch (e) {
						console.error(`Invalid regex for excludeNamePattern: ${filterOptions.excludeNamePattern}`, e);
						// Decide how to handle invalid regex: skip exclusion or throw error? Skipping for now.
					}
				}
				// If not excluded, add it
				entriesToInclude.add(parent.id);
				itemsToAdd.push(parent); // Add parent to the queue to check its parents
			}
		}
	}


	// 4. Add children of included entries recursively (optional, depends on desired behavior)
	// If you want to include all descendants of a matched item:
	// Commented-out legacy code removed

	// 5. Filter the original deep copy based on the final set of IDs to include
	let result = definitionsCopy.filter(def => def.id && entriesToInclude.has(def.id));

	// 6. Rebuild children arrays for the final filtered list
	const finalIds = new Set(result.map(def => def.id));
	result.forEach(def => {
		if (def.children) {
			def.children = def.children.filter(childId => finalIds.has(childId));
		}
		// Ensure parentId is valid within the filtered set, otherwise remove it
		if (def.parentId && !finalIds.has(def.parentId)) {
			def.parentId = undefined;
		}
	});

	// 7. Add back the metadata/error entries
	result = [...metaEntries, ...result];


	// 8. Final sort (optional, e.g., by start line)
	result.sort((a, b) => a.startLine - b.startLine);


	return result;
}


// --- Parent-Child Relationship Update ---
// This function ensures parentId and children arrays are consistent after potential modifications
function updateParentChildRelationships(definitions: Definition[]): Definition[] {
	if (!definitions) return [];
	const idToIndexMap = new Map(definitions.map((def, index) => [def.id, index]));

	definitions.forEach((def, index) => {
		// Reset children array for recalculation
		definitions[index].children = [];
	});

	definitions.forEach((def, index) => {
		if (def.parentId) {
			const parentIndex = idToIndexMap.get(def.parentId);
			if (parentIndex !== undefined) {
				// Ensure parent's children array exists
				if (!definitions[parentIndex].children) {
					definitions[parentIndex].children = [];
				}
				// Add current def ID to parent's children if not already present
				if (def.id && !definitions[parentIndex].children!.includes(def.id)) {
					definitions[parentIndex].children!.push(def.id);
				}
			} else {
				// Parent ID exists but parent definition not found in the list, remove parentId
				definitions[index].parentId = undefined;
			}
		}
	});

	return definitions;
}


// --- CLI Argument Parsing and Execution --- Refactored
async function runCli() {
    const argv = await yargs(hideBin(process.argv))
        .option('directory', {
            alias: 'd',
            type: 'string',
            description: 'The directory to scan',
            demandOption: false, // Make it optional initially to check if CLI mode is intended
        })
        .option('patterns', {
            alias: 'p',
            type: 'array',
            string: true, // Ensure array elements are treated as strings
            description: 'Glob patterns for file extensions to include',
            default: defaultFilePatterns,
        })
        .option('format', {
            alias: 'f',
            type: 'string',
            choices: ['xml', 'markdown', 'json'],
            description: 'Output format',
            default: 'markdown',
        })
        .option('detail', {
            alias: 'l',
            type: 'string',
            choices: ['minimal', 'standard', 'detailed'],
            description: 'Level of detail to include in the output',
            default: 'standard',
        })
        .option('include-types', {
            type: 'array',
            string: true,
            description: 'Element types to include (e.g., class,method)',
        })
        .option('exclude-types', {
            type: 'array',
            string: true,
            description: 'Element types to exclude',
        })
        .option('include-modifiers', {
            type: 'array',
            string: true,
            description: 'Modifiers to include (e.g., public,private)',
        })
        .option('exclude-modifiers', {
            type: 'array',
            string: true,
            description: 'Modifiers to exclude',
        })
        .option('name-pattern', {
            type: 'string',
            description: 'Regex pattern to match element names',
        })
        .option('exclude-name-pattern', {
            type: 'string',
            description: 'Regex pattern to exclude element names',
        })
        .option('include-paths', {
            type: 'array',
            string: true,
            description: 'Additional file path patterns to include',
        })
        .option('exclude-paths', {
            type: 'array',
            string: true,
            description: 'File path patterns to exclude',
        })
        .help()
        .alias('help', 'h')
        .argv;

    // Check if --directory was provided, indicating CLI usage
    if (argv.directory) {
        try {
            // Build filter options from CLI arguments
            const filterOptions: FilterOptions = {};

            // Process include-types - split comma-separated values if needed
            if (argv['include-types']) {
                const types = argv['include-types'] as string[];
                filterOptions.includeTypes = types.flatMap(t => t.includes(',') ? t.split(',') : t);
            }

            // Process exclude-types - split comma-separated values if needed
            if (argv['exclude-types']) {
                const types = argv['exclude-types'] as string[];
                filterOptions.excludeTypes = types.flatMap(t => t.includes(',') ? t.split(',') : t);
            }

            // Process include-modifiers - split comma-separated values if needed
            if (argv['include-modifiers']) {
                const mods = argv['include-modifiers'] as string[];
                filterOptions.includeModifiers = mods.flatMap(m => m.includes(',') ? m.split(',') : m);
            }

            // Process exclude-modifiers - split comma-separated values if needed
            if (argv['exclude-modifiers']) {
                const mods = argv['exclude-modifiers'] as string[];
                filterOptions.excludeModifiers = mods.flatMap(m => m.includes(',') ? m.split(',') : m);
            }

            if (argv['name-pattern']) filterOptions.namePattern = argv['name-pattern'] as string;
            if (argv['exclude-name-pattern']) filterOptions.excludeNamePattern = argv['exclude-name-pattern'] as string;

            // Process include-paths - split comma-separated values if needed
            if (argv['include-paths']) {
                const paths = argv['include-paths'] as string[];
                filterOptions.includePaths = paths.flatMap(p => p.includes(',') ? p.split(',') : p);
            }

            // Process exclude-paths - split comma-separated values if needed
            if (argv['exclude-paths']) {
                const paths = argv['exclude-paths'] as string[];
                filterOptions.excludePaths = paths.flatMap(p => p.includes(',') ? p.split(',') : p);
            }

            const output = await performScan(
                argv.directory,
                argv.patterns as string[], // Cast needed due to yargs typing
                argv.format as 'xml' | 'markdown' | 'json',
                argv.detail as 'minimal' | 'standard' | 'detailed',
                filterOptions
            );
            console.log(output); // Print result to stdout for CLI use
            process.exit(0); // Exit successfully after CLI run
        } catch (error: any) {
            console.error("Error during CLI scan:", error.message);
            process.exit(1); // Exit with error
        }
    } else {
        // No --directory provided, assume MCP server mode
        return false; // Indicate MCP mode should proceed
    }
    return true; // Indicate CLI mode was handled
}

// --- MCP Server Setup --- (Only runs if not in CLI mode)
const server = new Server(
	{
		name: "code-scanner-server",
		version: "0.1.1",
		description:
			"A tool that scans code files (JS, TS, C#, PHP, CSS) for definitions like functions, classes, methods, etc., respecting .gitignore and providing line numbers. Output format: XML, Markdown, or JSON.",
	},
	{
		capabilities: {
			tools: {},
		},
	}
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: "scan_code",
				description:
					"Scans a directory for code files (JS, TS, C#, PHP, CSS, respecting .gitignore) and lists definitions (functions, classes, etc.) with line numbers. Supports XML, Markdown, and JSON output.",
				inputSchema: {
					type: "object",
					properties: {
						directory: {
							type: "string",
							description:
								"The absolute path to the directory to scan. Relative paths are not supported.",
						},
						filePatterns: {
							type: "array",
							items: { type: "string" },
							description:
								"Glob patterns for file extensions to include.",
							default: defaultFilePatterns, // Use consistent defaults
						},
						outputFormat: {
							type: "string",
							enum: ["xml", "markdown", "json"],
							description: "Output format for the results.",
							default: "markdown",
						},
						detailLevel: {
							type: "string",
							enum: ["minimal", "standard", "detailed"],
							description: "Level of detail to include in the output.",
							default: "standard",
						},
						includeTypes: {
							type: "array",
							items: { type: "string" },
							description: "Element types to include (e.g., class, method).",
						},
						excludeTypes: {
							type: "array",
							items: { type: "string" },
							description: "Element types to exclude.",
						},
						includeModifiers: {
							type: "array",
							items: { type: "string" },
							description: "Modifiers to include (e.g., public, private).",
						},
						excludeModifiers: {
							type: "array",
							items: { type: "string" },
							description: "Modifiers to exclude.",
						},
						namePattern: {
							type: "string",
							description: "Regex pattern to match element names.",
						},
						excludeNamePattern: {
							type: "string",
							description: "Regex pattern to exclude element names.",
						},
						includePaths: {
							type: "array",
							items: { type: "string" },
							description: "Additional file path patterns to include.",
						},
						excludePaths: {
							type: "array",
							items: { type: "string" },
							description: "File path patterns to exclude.",
						},
					},
					required: ["directory"],
				},
			},
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name !== "scan_code") {
		throw new McpError(
			ErrorCode.MethodNotFound,
			`Unknown tool: ${request.params.name}`
		);
	}

	const args = request.params.arguments;

	// Validate directory argument
	if (typeof args?.directory !== "string") {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Missing or invalid 'directory' argument (must be a string)."
		);
	}
	// Ensure directory is an absolute path
	if (!path.isAbsolute(args.directory)) {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Invalid 'directory' argument: Path must be absolute."
		);
	}

	const filePatterns =
		args?.filePatterns && Array.isArray(args.filePatterns)
			? args.filePatterns
			: defaultFilePatterns; // Use consistent defaults
	const outputFormat = // Default to markdown unless 'xml' or 'json' is specified
		args?.outputFormat === "xml" ? "xml" :
		args?.outputFormat === "json" ? "json" : "markdown";
	const detailLevel =
		args?.detailLevel === "minimal" || args?.detailLevel === "detailed" ?
		args.detailLevel : "standard"; // Default to standard unless specified

	// Build filter options from MCP arguments
	const filterOptions: FilterOptions = {};

	// Process include-types - split comma-separated values if needed
	if (args?.includeTypes && Array.isArray(args.includeTypes)) {
		filterOptions.includeTypes = args.includeTypes.flatMap(t =>
			typeof t === 'string' && t.includes(',') ? t.split(',') : t
		);
	}

	// Process exclude-types - split comma-separated values if needed
	if (args?.excludeTypes && Array.isArray(args.excludeTypes)) {
		filterOptions.excludeTypes = args.excludeTypes.flatMap(t =>
			typeof t === 'string' && t.includes(',') ? t.split(',') : t
		);
	}

	// Process include-modifiers - split comma-separated values if needed
	if (args?.includeModifiers && Array.isArray(args.includeModifiers)) {
		filterOptions.includeModifiers = args.includeModifiers.flatMap(m =>
			typeof m === 'string' && m.includes(',') ? m.split(',') : m
		);
	}

	// Process exclude-modifiers - split comma-separated values if needed
	if (args?.excludeModifiers && Array.isArray(args.excludeModifiers)) {
		filterOptions.excludeModifiers = args.excludeModifiers.flatMap(m =>
			typeof m === 'string' && m.includes(',') ? m.split(',') : m
		);
	}

	if (args?.namePattern && typeof args.namePattern === 'string') {
		filterOptions.namePattern = args.namePattern;
	}

	if (args?.excludeNamePattern && typeof args.excludeNamePattern === 'string') {
		filterOptions.excludeNamePattern = args.excludeNamePattern;
	}

	// Process include-paths - split comma-separated values if needed
	if (args?.includePaths && Array.isArray(args.includePaths)) {
		filterOptions.includePaths = args.includePaths.flatMap(p =>
			typeof p === 'string' && p.includes(',') ? p.split(',') : p
		);
	}

	// Process exclude-paths - split comma-separated values if needed
	if (args?.excludePaths && Array.isArray(args.excludePaths)) {
		filterOptions.excludePaths = args.excludePaths.flatMap(p =>
			typeof p === 'string' && p.includes(',') ? p.split(',') : p
		);
	}

	try {
        // Call the refactored function
		const outputText = await performScan(
			args.directory,
			filePatterns,
			outputFormat,
			detailLevel as 'minimal' | 'standard' | 'detailed',
			filterOptions
		);

		return {
			content: [
				{
					type: "text",
					text: outputText,
				},
			],
		};
	} catch (error: any) {
		console.error(`Error during scan_code execution: ${error}`);
		// If it's an error from performScan, wrap it in McpError
        if (error instanceof Error && !(error instanceof McpError)) {
             throw new McpError(
                ErrorCode.InternalError,
                `Failed to scan directory: ${error.message}`
            );
        }
        // Re-throw McpErrors or other unexpected errors
		throw error;
	}
});

// --- Server Start --- (Conditional)
async function startMcpServer() {
	const transport = new StdioServerTransport();
	server.onerror = (error) => console.error("[MCP Error]", error);

	process.on("SIGINT", async () => {
		console.log("Received SIGINT, shutting down server...");
		await server.close();
		process.exit(0);
	});
	process.on("SIGTERM", async () => {
		console.log("Received SIGTERM, shutting down server...");
		await server.close();
		process.exit(0);
	});

	try {
		await server.connect(transport);
		console.error("Code Scanner MCP server (Tree-sitter) running on stdio");
	} catch (error) {
		console.error("Failed to start Code Scanner MCP server:", error);
		process.exit(1);
	}
}

// --- Main Execution Logic ---
(async () => {
	// Try running as CLI first
	const cliModeHandled = await runCli();

	// If CLI mode was not triggered (no --directory), start the MCP server
	if (!cliModeHandled) {
		await startMcpServer();
	}
})();
