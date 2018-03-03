// @flow

type U32Literal = NumberLiteral;
type Byte = Number;

type NumericLiteral = FloatLiteral | NumberLiteral | LongNumberLiteral;

type SectionName =
  | "custom"
  | "type"
  | "import"
  | "function"
  | "table"
  | "memory"
  | "global"
  | "export"
  | "start"
  | "element"
  | "code"
  | "data";

type FloatLiteral = {
  type: "FloatLiteral",
  value: number,
  nan?: boolean,
  inf?: boolean
};

type Typeidx = U32Literal;
type Funcidx = U32Literal;
type Tableidx = U32Literal;
type Memidx = U32Literal;
type Globalidx = U32Literal;
type Localidx = U32Literal;
type Labelidx = U32Literal;

type ModuleType =
  | "Module"
  | "BinaryModule" // WAST
  | "QuoteModule"; // WAST

type Index =
  | Typeidx
  | Funcidx
  | Tableidx
  | Memidx
  | Globalidx
  | Localidx
  | Labelidx
  | Identifier; // WAST shorthand

type Valtype = "i32" | "i64" | "f32" | "f64" | "u32" | "label";
type ExportDescr = "Func" | "Table" | "Memory" | "Global";
type Mutability = "const" | "var";
type InstructionType = "Instr" | ControlInstruction;
type ControlInstruction =
  | "CallInstruction"
  | "CallIndirectInstruction"
  | "BlockInstruction"
  | "LoopInstruction"
  | "IfInstruction";

type NodePath<T> = {
  node: T,
  parentPath: ?NodePath<Node>,

  replaceWith: Node => void,
  remove: () => void
};

type Expression =
  | Identifier
  | NumericLiteral
  | ValtypeLiteral
  | Instruction
  | StringLiteral;

type TableElementType = "anyfunc";

/**
 * AST types
 */

interface LongNumber {
  high: number;
  low: number;
}

interface Position {
  line: number;
  column: number;
}

interface SourceLocation {
  start: Position;
  end?: Position;
}

interface Node {
  type: any;
  loc?: ?SourceLocation;

  // Internal property
  _deleted?: ?boolean;
}

interface Program {
  type: "Program";
  body: Array<Node>;
}

/**
 * Concrete values
 */
interface StringLiteral {
  type: "StringLiteral";
  value: string;
}

interface NumberLiteral {
  type: "NumberLiteral";
  value: number;
}

interface LongNumberLiteral {
  type: "LongNumberLiteral";
  value: LongNumber;
}

interface Identifier {
  type: "Identifier";
  value: string;
}

/**
 * Module structure
 */

type ModuleFields = Array<Node>;

interface Module {
  type: ModuleType;
  id: ?string;
  fields: ModuleFields;
  metadata?: ModuleMetadata;
}

type ModuleMetadata = {
  sections: Array<SectionMetadata>
};

type SectionMetadata = {
  type: "SectionMetadata",
  section: SectionName,

  // after the section id byte
  startOffset: number,
  size: number,

  // Size of the vector in the section (if any)
  vectorOfSize: number
};

type BinaryModule = Module & {
  type: "BinaryModule",
  blob: Array<string>
};

type QuoteModule = Module & {
  type: "QuoteModule",
  string: Array<string>
};

type FuncParam = {
  id: ?string,
  valtype: Valtype
};

interface Func {
  type: "Func";

  // Only in WAST
  name: ?Index;

  params: Array<FuncParam>;
  result: Array<Valtype>;
  body: Array<Instruction>;

  // Means that it has been imported from the outside js
  isExternal?: boolean;
}

/**
 * Instructions
 */
type Instruction =
  | LoopInstruction
  | BlockInstruction
  | IfInstruction
  | CallInstruction
  | CallIndirectInstruction
  | GenericInstruction
  | ObjectInstruction;

type GenericInstruction = {
  type: InstructionType,
  id: string,
  args: Array<Expression>,

  // key=value for special instruction arguments
  namedArgs?: Object
};

type ObjectInstruction = GenericInstruction & {
  object: Valtype
};

type LoopInstruction = {
  type: "LoopInstruction",
  label: ?Identifier,
  resulttype: ?Valtype,
  instr: Array<Instruction>
};

type BlockInstruction = {
  type: "BlockInstruction",
  label: ?Identifier,
  instr: Array<Instruction>,
  result: ?Valtype
};

type IfInstruction = {
  type: "IfInstruction",
  testLabel: Identifier, // only for WAST
  result: ?Valtype,
  test: Array<Instruction>,
  consequent: Array<Instruction>,
  alternate: Array<Instruction>
};

type CallInstruction = {
  type: "CallInstruction",
  index: Index,
  instrArgs?: Array<Expression> // only for WAST
};

type CallIndirectInstruction = {
  type: "CallIndirectInstruction",
  params: Array<FuncParam>,
  results: Array<Valtype>,
  intrs: Array<Expression>
};

interface ModuleExport {
  type: "ModuleExport";
  name: string;
  descr: {
    type: ExportDescr,
    id: Index
  };
}

type Limit = {
  type: "Limit",
  min: number,
  max?: number
};

type FuncImportDescr = {
  type: "FuncImportDescr",
  id: Identifier,
  params: Array<FuncParam>,
  results: Array<Valtype>
};

type ImportDescr = FuncImportDescr | GlobalType | Memory | Table;

type ModuleImport = {
  ...Node,

  type: "ModuleImport",
  module: string,
  name: string,
  descr: ImportDescr
};

type Table = {
  type: "Table",
  elementType: TableElementType,
  elements?: Array<Index>,
  limits: Limit,
  name: ?Identifier
};

type Memory = {
  type: "Memory",
  limits: Limit,
  id: ?Index
};

type ByteArray = {
  type: "Bytes",
  values: Array<Byte>
};

type Data = {
  type: "Data",
  memoryIndex: Memidx,
  offset: Instruction,
  init: ByteArray
};

type Global = {
  type: "Global",
  globalType: GlobalType,
  init: Array<Instruction>,
  name: ?Identifier
};

type GlobalType = {
  type: "GlobalType",
  valtype: Valtype,
  mutability: Mutability
};

type LeadingComment = {
  type: "LeadingComment",
  value: string
};

type BlockComment = {
  type: "BlockComment",
  value: string
};

type ValtypeLiteral = {
  type: "ValtypeLiteral",
  name: Valtype
};

type TypeInstruction = {
  type: "TypeInstruction",
  id: ?Index,
  functype: {
    params: Array<FuncParam>,
    result: Array<Valtype>
  }
};

type Start = {
  type: "Start",
  index: Index
};

type Elem = {
  type: "Elem",
  table: Index,

  // multiple expression are allow in WAST
  offset: Array<Instruction>,

  funcs: Array<Index>
};
