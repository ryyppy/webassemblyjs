// @flow

import { CompileError } from "webassemblyjs/lib/errors";
const t = require("@webassemblyjs/ast");
const {
  importTypes,
  symbolsByByte,
  blockTypes,
  tableTypes,
  globalTypes,
  limitHasMaximum,
  exportTypes,
  types,
  magicModuleHeader,
  valtypes,
  moduleVersion,
  sections
} = require("@webassemblyjs/helper-wasm-bytecode");

const {
  decodeInt32,
  decodeUInt32,
  MAX_NUMBER_OF_BYTE_U32,

  decodeInt64,
  decodeUInt64,
  MAX_NUMBER_OF_BYTE_U64
} = require("@webassemblyjs/helper-leb128");

const ieee754 = require("./ieee754");
const { utf8ArrayToStr } = require("./utf8");

/**
 * FIXME(sven): we can't do that because number > 2**53 will fail here
 * because they cannot be represented in js.
 */
function badI32ToI64Conversion(value: number): LongNumber {
  return {
    high: value < 0 ? -1 : 0,
    low: value >>> 0
  };
}

function toHex(n: number): string {
  return "0x" + Number(n).toString(16);
}

function byteArrayEq(l: Array<Byte>, r: Array<Byte>): boolean {
  if (l.length !== r.length) {
    return false;
  }

  for (let i = 0; i < l.length; i++) {
    if (l[i] !== r[i]) {
      return false;
    }
  }

  return true;
}

export function decode(ab: ArrayBuffer, opts: DecoderOpts): Program {
  const buf = new Uint8Array(ab);

  let inc = 0;

  function getUniqueName(prefix: string = "temp"): string {
    inc++;

    return prefix + "_" + inc;
  }

  let offset = 0;

  function dump(b: Array<Byte>, msg: any) {
    if (opts.dump === false) return;

    const pad = "\t\t\t\t\t\t\t\t\t\t";
    let str = "";

    if (b.length < 5) {
      str = b.map(toHex).join(" ");
    } else {
      str = "...";
    }

    console.log(toHex(offset) + ":\t", str, pad, ";", msg);
  }

  function dumpSep(msg: string) {
    if (opts.dump === false) return;

    console.log(";", msg);
  }

  /**
   * TODO(sven): we can atually use a same structure
   * we are adding incrementally new features
   */
  const state: State = {
    elementsInFuncSection: [],
    elementsInExportSection: [],
    elementsInCodeSection: [],

    /**
     * Decode memory from:
     * - Memory section
     */
    memoriesInModule: [],

    /**
     * Decoded types from:
     * - Type section
     */
    typesInModule: [],

    /**
     * Decoded functions from:
     * - Function section
     * - Import section
     */
    functionsInModule: []
  };

  function isEOF(): boolean {
    return offset >= buf.length;
  }

  function eatBytes(n: number) {
    offset = offset + n;
  }

  function readBytes(numberOfBytes: number): Array<Byte> {
    const arr = [];

    for (let i = 0; i < numberOfBytes; i++) {
      arr.push(buf[offset + i]);
    }

    return arr;
  }

  function readF64(): DecodedF64 {
    const bytes = readBytes(ieee754.NUMBER_OF_BYTE_F64);
    const buffer = Buffer.from(bytes);

    const value = ieee754.decode(
      buffer,
      0,
      true,
      ieee754.SINGLE_PRECISION_MANTISSA,
      ieee754.NUMBER_OF_BYTE_F64
    );

    return {
      value,
      nextIndex: ieee754.NUMBER_OF_BYTE_F64
    };
  }

  function readF32(): DecodedF32 {
    const bytes = readBytes(ieee754.NUMBER_OF_BYTE_F32);
    const buffer = Buffer.from(bytes);

    const value = ieee754.decode(
      buffer,
      0,
      true,
      ieee754.SINGLE_PRECISION_MANTISSA,
      ieee754.NUMBER_OF_BYTE_F32
    );

    return {
      value,
      nextIndex: ieee754.NUMBER_OF_BYTE_F32
    };
  }

  function readUTF8String(): DecodedUTF8String {
    const lenu32 = readU32();
    const len = lenu32.value;

    dump([len], "string length");

    eatBytes(lenu32.nextIndex);

    const bytes = readBytes(len);
    const value = utf8ArrayToStr(bytes);

    return {
      value,
      nextIndex: len
    };
  }

  /**
   * Decode an unsigned 32bits integer
   *
   * The length will be handled by the leb librairy, we pass the max number of
   * byte.
   */
  function readU32(): Decoded32 {
    const bytes = readBytes(MAX_NUMBER_OF_BYTE_U32);
    const buffer = Buffer.from(bytes);

    return decodeUInt32(buffer);
  }

  /**
   * Decode a signed 32bits interger
   */
  function read32(): Decoded32 {
    const bytes = readBytes(MAX_NUMBER_OF_BYTE_U32);
    const buffer = Buffer.from(bytes);

    return decodeInt32(buffer);
  }

  /**
   * Decode a signed 64bits integer
   */
  function read64(): Decoded64 {
    const bytes = readBytes(MAX_NUMBER_OF_BYTE_U64);
    const buffer = Buffer.from(bytes);

    return decodeInt64(buffer);
  }

  function readU64(): Decoded64 {
    const bytes = readBytes(MAX_NUMBER_OF_BYTE_U64);
    const buffer = Buffer.from(bytes);

    return decodeUInt64(buffer);
  }

  function readByte(): Byte {
    return readBytes(1)[0];
  }

  function parseModuleHeader() {
    if (isEOF() === true || offset + 4 > buf.length) {
      throw new Error("unexpected end");
    }

    const header = readBytes(4);

    if (byteArrayEq(magicModuleHeader, header) === false) {
      throw new CompileError("magic header not detected");
    }

    dump(header, "wasm magic header");

    eatBytes(4);
  }

  function parseVersion() {
    if (isEOF() === true || offset + 4 > buf.length) {
      throw new Error("unexpected end");
    }

    const version = readBytes(4);

    if (byteArrayEq(moduleVersion, version) === false) {
      throw new CompileError("unknown binary version");
    }

    dump(version, "wasm version");

    eatBytes(4);
  }

  function parseVec<T>(cast: Byte => T): Array<T> {
    // Int on 1byte
    const u32 = readU32();
    const length = u32.value;
    eatBytes(u32.nextIndex);

    dump([length], "number");

    if (length === 0) {
      return [];
    }

    const elements = [];

    for (let i = 0; i < length; i++) {
      const byte = readByte();
      eatBytes(1);

      const value = cast(byte);

      dump([byte], value);

      if (typeof value === "undefined") {
        throw new CompileError(
          "Internal failure: parseVec could not cast the value"
        );
      }

      elements.push(value);
    }

    return elements;
  }

  // Type section
  // https://webassembly.github.io/spec/binary/modules.html#binary-typesec
  function parseTypeSection(numberOfTypes: number) {
    dump([numberOfTypes], "num types");

    for (let i = 0; i < numberOfTypes; i++) {
      dumpSep("type " + i);

      const type = readByte();
      eatBytes(1);

      if (type == types.func) {
        dump([type], "func");

        const paramValtypes: Array<Valtype> = parseVec(b => valtypes[b]);
        const params = paramValtypes.map(v => t.funcParam(v));

        const result: Array<Valtype> = parseVec(b => valtypes[b]);

        state.typesInModule.push({
          params,
          result
        });
      } else {
        throw new Error("Unsupported type: " + toHex(type));
      }
    }
  }

  // Import section
  // https://webassembly.github.io/spec/binary/modules.html#binary-importsec
  function parseImportSection(numberOfImports: number) {
    const imports = [];

    for (let i = 0; i < numberOfImports; i++) {
      dumpSep("import header " + i);

      const startLoc = { line: -1, column: offset };

      /**
       * Module name
       */
      const moduleName = readUTF8String();
      eatBytes(moduleName.nextIndex);

      dump([], `module name (${moduleName.value})`);

      /**
       * Name
       */
      const name = readUTF8String();
      eatBytes(name.nextIndex);

      dump([], `name (${name.value})`);

      /**
       * Import descr
       */
      const descrTypeByte = readByte();
      eatBytes(1);

      const descrType = importTypes[descrTypeByte];

      dump([descrTypeByte], "import kind");

      if (typeof descrType === "undefined") {
        throw new CompileError(
          "Unknown import description type: " + toHex(descrTypeByte)
        );
      }

      let importDescr;

      if (descrType === "func") {
        const indexU32 = readU32();
        const typeindex = indexU32.value;
        eatBytes(indexU32.nextIndex);

        dump([typeindex], "type index");

        const signature = state.typesInModule[typeindex];

        if (typeof signature === "undefined") {
          throw new CompileError(
            "function signature not found in type section"
          );
        }

        const id = t.identifier(`${moduleName.value}.${name.value}`);

        importDescr = t.funcImportDescr(id, signature.params, signature.result);

        state.functionsInModule.push({
          id: t.identifier(name.value),
          signature,
          isExternal: true
        });
      } else if (descrType === "global") {
        importDescr = parseGlobalType();
      } else if (descrType === "table") {
        importDescr = parseTableType();
      } else if (descrType === "mem") {
        const memoryNode = parseMemoryType(0);

        state.memoriesInModule.push(memoryNode);

        importDescr = memoryNode;
      } else {
        throw new CompileError("Unsupported import of type: " + descrType);
      }

      const endLoc = { line: -1, column: offset };

      imports.push(
        t.withLoc(
          t.moduleImport(moduleName.value, name.value, importDescr),
          endLoc,
          startLoc
        )
      );
    }

    return imports;
  }

  // Function section
  // https://webassembly.github.io/spec/binary/modules.html#function-section
  function parseFuncSection(numberOfFunctions: number) {
    for (let i = 0; i < numberOfFunctions; i++) {
      const indexU32 = readU32();
      const typeindex = indexU32.value;
      eatBytes(indexU32.nextIndex);

      dump([typeindex], "type index");

      const signature = state.typesInModule[typeindex];

      if (typeof signature === "undefined") {
        throw new CompileError("function signature not found");
      }

      const id = t.identifier(getUniqueName("func"));

      state.functionsInModule.push({
        id,
        signature,
        isExternal: false
      });
    }
  }

  // Export section
  // https://webassembly.github.io/spec/binary/modules.html#export-section
  function parseExportSection(numberOfExport: number) {
    dump([numberOfExport], "num exports");

    // Parse vector of exports
    for (let i = 0; i < numberOfExport; i++) {
      const startLoc = { line: -1, column: offset };

      /**
       * Name
       */
      const name = readUTF8String();
      eatBytes(name.nextIndex);

      dump([], `export name (${name.value})`);

      /**
       * exportdescr
       */

      const typeIndex = readByte();
      eatBytes(1);

      dump([typeIndex], "export kind");

      const indexu32 = readU32();
      const index = indexu32.value;
      eatBytes(indexu32.nextIndex);

      dump([index], "export index");

      let id: Identifier, signature;

      if (exportTypes[typeIndex] === "Func") {
        const func = state.functionsInModule[index];

        if (typeof func === "undefined") {
          throw new CompileError(
            `entry not found at index ${index} in function section`
          );
        }

        id = func.id;
        signature = func.signature;
      } else if (exportTypes[typeIndex] === "Table") {
        console.warn("Unsupported export type table");
        return;
      } else if (exportTypes[typeIndex] === "Mem") {
        const memNode = state.memoriesInModule[index];

        if (typeof memNode === "undefined") {
          throw new CompileError(
            `entry not found at index ${index} in memory section`
          );
        }

        if (memNode.id != null) {
          id = t.identifier(memNode.id.value + "");
        } else {
          id = t.identifier(getUniqueName("memory"));
        }

        signature = null;
      } else {
        console.warn("Unsupported export type: " + toHex(typeIndex));
        return;
      }

      const endLoc = { line: -1, column: offset };

      state.elementsInExportSection.push({
        name: name.value,
        type: exportTypes[typeIndex],
        signature,
        id,
        index,
        endLoc,
        startLoc
      });
    }
  }

  // Code section
  // https://webassembly.github.io/spec/binary/modules.html#code-section
  function parseCodeSection(numberOfFuncs: number) {
    dump([numberOfFuncs], "number functions");

    // Parse vector of function
    for (let i = 0; i < numberOfFuncs; i++) {
      dumpSep("function body " + i);

      // the u32 size of the function code in bytes
      // Ignore it for now
      const bodySizeU32 = readU32();
      eatBytes(bodySizeU32.nextIndex);

      dump([0x0], "function body size (guess)");

      const code: Array<Instruction> = [];

      /**
       * Parse locals
       */
      const funcLocalNumU32 = readU32();
      const funcLocalNum = funcLocalNumU32.value;
      eatBytes(funcLocalNumU32.nextIndex);

      dump([funcLocalNum], "num locals");

      const locals = [];

      for (let i = 0; i < funcLocalNum; i++) {
        const localCountU32 = readU32();
        const localCount = localCountU32.value;
        eatBytes(localCountU32.nextIndex);

        dump([localCount], "num local");

        const valtypeByte = readByte();
        eatBytes(1);

        const type = valtypes[valtypeByte];

        dump([valtypeByte], type);

        if (typeof type === "undefined") {
          throw new CompileError("Unexpected valtype: " + toHex(valtypeByte));
        }
      }

      // Decode instructions until the end
      parseInstructionBlock(code);

      state.elementsInCodeSection.push({
        code,
        locals
      });
    }
  }

  function parseInstructionBlock(code: Array<Instruction>) {
    while (true) {
      let instructionAlreadyCreated = false;

      const instructionByte = readByte();
      eatBytes(1);

      const instruction = symbolsByByte[instructionByte];

      if (typeof instruction.object === "string") {
        dump([instructionByte], `${instruction.object}.${instruction.name}`);
      } else {
        dump([instructionByte], instruction.name);
      }

      if (typeof instruction === "undefined") {
        throw new CompileError(
          "Unexpected instruction: " + toHex(instructionByte)
        );
      }

      /**
       * End of the function
       */
      if (instruction.name === "end") {
        break;
      }

      const args = [];

      if (instruction.name === "loop") {
        const blocktypeByte = readByte();
        eatBytes(1);

        const blocktype = blockTypes[blocktypeByte];

        dump([blocktypeByte], "blocktype");

        if (typeof blocktype === "undefined") {
          throw new CompileError(
            "Unexpected blocktype: " + toHex(blocktypeByte)
          );
        }

        const instr = [];

        parseInstructionBlock(instr);

        const label = t.identifier(getUniqueName("loop"));
        const loopNode = t.loopInstruction(label, blocktype, instr);

        code.push(loopNode);
        instructionAlreadyCreated = true;
      } else if (instruction.name === "if") {
        const blocktypeByte = readByte();
        eatBytes(1);

        const blocktype = blockTypes[blocktypeByte];

        dump([blocktypeByte], "blocktype");

        if (typeof blocktype === "undefined") {
          throw new CompileError(
            "Unexpected blocktype: " + toHex(blocktypeByte)
          );
        }

        const consequentInstr = [];
        parseInstructionBlock(consequentInstr);

        // FIXME(sven): handle the second block via the byte in between
        const alternate = [];

        // FIXME(sven): where is that stored?
        const testIndex = t.identifier(getUniqueName("ifindex"));
        const testInstrs = [];

        const ifNode = t.ifInstruction(
          testIndex,
          blocktype,
          testInstrs,
          consequentInstr,
          alternate
        );

        code.push(ifNode);
        instructionAlreadyCreated = true;
      } else if (instruction.name === "block") {
        const blocktypeByte = readByte();
        eatBytes(1);

        const blocktype = blockTypes[blocktypeByte];

        dump([blocktypeByte], "blocktype");

        if (typeof blocktype === "undefined") {
          throw new CompileError(
            "Unexpected blocktype: " + toHex(blocktypeByte)
          );
        }

        const instr = [];
        parseInstructionBlock(instr);

        const label = t.identifier(getUniqueName());

        // FIXME(sven): result type is ignored?
        const blockNode = t.blockInstruction(label, instr);

        code.push(blockNode);
        instructionAlreadyCreated = true;
      } else if (instruction.name === "call") {
        const indexu32 = readU32();
        const index = indexu32.value;
        eatBytes(indexu32.nextIndex);

        dump([index], "index");

        const callNode = t.callInstruction(t.indexLiteral(index));

        code.push(callNode);
        instructionAlreadyCreated = true;
      } else if (instruction.name === "br_table") {
        const indicesu32 = readU32();
        const indices = indicesu32.value;
        eatBytes(indicesu32.nextIndex);

        dump([indices], "num indices");

        for (let i = 0; i < indices; i++) {
          const indexu32 = readU32();
          const index = indexu32.value;
          eatBytes(indexu32.nextIndex);

          dump([index], "index");
        }

        const labelIndexu32 = readU32();
        const labelIndex = labelIndexu32.value;
        eatBytes(labelIndexu32.nextIndex);

        dump([labelIndex], "label index");
      } else if (instructionByte >= 0x28 && instructionByte <= 0x40) {
        /**
         * Memory instructions
         */
        const aligun32 = readU32();
        const align = aligun32.value;
        eatBytes(aligun32.nextIndex);

        dump([align], "align");

        const offsetu32 = readU32();
        const offset = offsetu32.value;
        eatBytes(offsetu32.nextIndex);

        dump([offset], "offset");
      } else if (instructionByte >= 0x41 && instructionByte <= 0x44) {
        /**
         * Numeric instructions
         */
        if (instruction.object === "i32") {
          const value32 = read32();
          const value = value32.value;
          eatBytes(value32.nextIndex);

          dump([value], "value");

          args.push(t.numberLiteral(value));
        }

        if (instruction.object === "u32") {
          const valueu32 = readU32();
          const value = valueu32.value;
          eatBytes(valueu32.nextIndex);

          dump([value], "value");

          args.push(t.numberLiteral(value));
        }

        if (instruction.object === "i64") {
          const value64 = read64();
          const value = value64.value;
          eatBytes(value64.nextIndex);

          dump([value], "value");

          const node = {
            type: "LongNumberLiteral",
            value: badI32ToI64Conversion(value)
          };

          args.push(node);
        }

        if (instruction.object === "u64") {
          const valueu64 = readU64();
          const value = valueu64.value;
          eatBytes(valueu64.nextIndex);

          dump([value], "value");

          args.push(t.numberLiteral(value));
        }

        if (instruction.object === "f32") {
          const valuef32 = readF32();
          const value = valuef32.value;
          eatBytes(valuef32.nextIndex);

          dump([value], "value");

          args.push(t.numberLiteral(value));
        }

        if (instruction.object === "f64") {
          const valuef64 = readF64();
          const value = valuef64.value;
          eatBytes(valuef64.nextIndex);

          dump([value], "value");

          args.push(t.numberLiteral(value));
        }
      } else {
        for (let i = 0; i < instruction.numberOfArgs; i++) {
          const u32 = readU32();
          eatBytes(u32.nextIndex);

          dump([u32.value], "argument " + i);

          args.push(t.numberLiteral(u32.value));
        }
      }

      if (instructionAlreadyCreated === false) {
        if (typeof instruction.object === "string") {
          code.push(
            // $FlowIgnore
            t.objectInstruction(instruction.name, instruction.object, args)
          );
        } else {
          code.push(t.instruction(instruction.name, args));
        }
      }
    }
  }

  // https://webassembly.github.io/spec/core/binary/types.html#binary-tabletype
  function parseTableType(): Table {
    const elementTypeByte = readByte();
    eatBytes(1);

    dump([elementTypeByte], "element type");

    const elementType = tableTypes[elementTypeByte];

    if (typeof elementType === "undefined") {
      throw new CompileError(
        "Unknown element type in table: " + toHex(elementType)
      );
    }

    const limitType = readByte();
    eatBytes(1);

    let min, max;

    if (limitHasMaximum[limitType] === true) {
      const u32min = readU32();
      min = u32min.value;
      eatBytes(u32min.nextIndex);

      dump([min], "min");

      const u32max = readU32();
      max = u32max.value;
      eatBytes(u32max.nextIndex);

      dump([max], "max");
    } else {
      const u32min = readU32();
      min = u32min.value;
      eatBytes(u32min.nextIndex);

      dump([min], "min");
    }

    return t.table(elementType, t.limits(min, max));
  }

  // https://webassembly.github.io/spec/binary/modules.html#binary-tablesec
  function parseTableSection(numberOfTable: number) {
    const tables = [];

    for (let i = 0; i < numberOfTable; i++) {
      const tableNode = parseTableType();
      tables.push(tableNode);
    }

    return tables;
  }

  // https://webassembly.github.io/spec/binary/types.html#global-types
  function parseGlobalType(): GlobalType {
    const valtypeByte = readByte();
    eatBytes(1);

    const type = valtypes[valtypeByte];

    dump([valtypeByte], type);

    if (typeof type === "undefined") {
      throw new CompileError("Unknown valtype: " + toHex(valtypeByte));
    }

    const globalTypeByte = readByte();
    eatBytes(1);

    const globalType = globalTypes[globalTypeByte];

    dump([globalTypeByte], `global type (${globalType})`);

    if (typeof globalType === "undefined") {
      throw new CompileError("Invalid mutability: " + toHex(globalTypeByte));
    }

    return t.globalType(type, globalType);
  }

  function parseGlobalSection(numberOfGlobals: number) {
    const globals = [];

    dump([numberOfGlobals], "num globals");

    for (let i = 0; i < numberOfGlobals; i++) {
      const globalType = parseGlobalType();

      /**
       * Global expressions
       */
      const init = [];

      parseInstructionBlock(init);

      globals.push(t.global(globalType, init));
    }

    return globals;
  }

  function parseElemSection(numberOfElements: number) {
    const elems = [];

    dump([numberOfElements], "num elements");

    for (let i = 0; i < numberOfElements; i++) {
      const tableindexu32 = readU32();
      const tableindex = tableindexu32.value;
      eatBytes(tableindexu32.nextIndex);

      dump([tableindex], "table index");

      /**
       * Parse instructions
       */
      const instr = [];
      parseInstructionBlock(instr);

      /**
       * Parse ( vector function index ) *
       */
      const indicesu32 = readU32();
      const indices = indicesu32.value;
      eatBytes(indicesu32.nextIndex);

      dump([indices], "num indices");

      const indexValues = [];

      for (let i = 0; i < indices; i++) {
        const indexu32 = readU32();
        const index = indexu32.value;
        eatBytes(indexu32.nextIndex);

        dump([index], "index");

        indexValues.push(t.indexLiteral(index));
      }

      elems.push(t.elem(t.indexLiteral(tableindex), instr, indexValues));
    }

    return elems;
  }

  // https://webassembly.github.io/spec/core/binary/types.html#memory-types
  function parseMemoryType(i: number): Memory {
    const limitType = readByte();
    eatBytes(1);

    let min, max;

    if (limitHasMaximum[limitType] === true) {
      const u32min = readU32();
      min = u32min.value;
      eatBytes(u32min.nextIndex);

      dump([min], "min");

      const u32max = readU32();
      max = u32max.value;
      eatBytes(u32max.nextIndex);

      dump([max], "max");
    } else {
      const u32min = readU32();
      min = u32min.value;
      eatBytes(u32min.nextIndex);

      dump([min], "min");
    }

    return t.memory(t.limits(min, max), t.indexLiteral(i));
  }

  // https://webassembly.github.io/spec/binary/modules.html#memory-section
  function parseMemorySection(numberOfElements: number) {
    const memories = [];

    dump([numberOfElements], "num elements");

    for (let i = 0; i < numberOfElements; i++) {
      const memoryNode = parseMemoryType(i);

      state.memoriesInModule.push(memoryNode);
      memories.push(memoryNode);
    }

    return memories;
  }

  // https://webassembly.github.io/spec/binary/modules.html#binary-startsec
  function parseStartSection() {
    const u32 = readU32();
    const startFuncIndex = u32.value;
    eatBytes(u32.nextIndex);

    dump([startFuncIndex], "index");

    return t.start(t.indexLiteral(startFuncIndex));
  }

  // https://webassembly.github.io/spec/binary/modules.html#data-section
  function parseDataSection(numberOfElements: number) {
    const dataEntries = [];

    dump([numberOfElements], "num elements");

    for (let i = 0; i < numberOfElements; i++) {
      const memoryIndexu32 = readU32();
      const memoryIndex = memoryIndexu32.value;
      eatBytes(memoryIndexu32.nextIndex);

      dump([memoryIndex], "memory index");

      const instrs: Array<Instruction> = [];
      parseInstructionBlock(instrs);

      if (instrs.length !== 1) {
        throw new CompileError(
          "data section offset must be a single instruction"
        );
      }

      let bytes: Array<Byte> = parseVec(b => b);

      // FIXME(sven): the Go binary can store > 100kb of data here
      // my testing suite doesn't handle that.
      // Disabling for now.
      bytes = [];

      dump([], "init");

      dataEntries.push(
        t.data(t.memIndexLiteral(memoryIndex), instrs[0], t.byteArray(bytes))
      );
    }

    return dataEntries;
  }

  // https://webassembly.github.io/spec/binary/modules.html#binary-section
  function parseSection(): { nodes: Array<Node>, metadata: SectionMetadata } {
    const sectionId = readByte();
    eatBytes(1);

    const startOffset = offset;

    const u32 = readU32();
    const sectionSizeInBytes = u32.value;
    eatBytes(u32.nextIndex);

    switch (sectionId) {
      case sections.type: {
        dumpSep("section Type");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const u32 = readU32();
        const numberOfTypes = u32.value;
        eatBytes(u32.nextIndex);

        const metadata = t.sectionMetadata(
          "type",
          startOffset,
          sectionSizeInBytes,
          numberOfTypes
        );

        parseTypeSection(numberOfTypes);

        const nodes = [];

        return { nodes, metadata };
      }

      case sections.table: {
        dumpSep("section Table");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const u32 = readU32();
        const numberOfTable = u32.value;
        eatBytes(u32.nextIndex);

        dump([numberOfTable], "num tables");

        const metadata = t.sectionMetadata(
          "table",
          startOffset,
          sectionSizeInBytes,
          numberOfTable
        );

        const nodes = parseTableSection(numberOfTable);

        return { nodes, metadata };
      }

      case sections.import: {
        dumpSep("section Import");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const numberOfImportsu32 = readU32();
        const numberOfImports = numberOfImportsu32.value;
        eatBytes(numberOfImportsu32.nextIndex);

        dump([numberOfImports], "number of imports");

        const metadata = t.sectionMetadata(
          "import",
          startOffset,
          sectionSizeInBytes,
          numberOfImports
        );

        const nodes = parseImportSection(numberOfImports);

        return { nodes, metadata };
      }

      case sections.func: {
        dumpSep("section Function");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const numberOfFunctionsu32 = readU32();
        const numberOfFunctions = numberOfFunctionsu32.value;
        eatBytes(numberOfFunctionsu32.nextIndex);

        const metadata = t.sectionMetadata(
          "function",
          startOffset,
          sectionSizeInBytes,
          numberOfFunctions
        );

        parseFuncSection(numberOfFunctions);

        const nodes = [];

        return { nodes, metadata };
      }

      case sections.export: {
        dumpSep("section Export");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const u32 = readU32();
        const numberOfExport = u32.value;
        eatBytes(u32.nextIndex);

        const metadata = t.sectionMetadata(
          "export",
          startOffset,
          sectionSizeInBytes,
          numberOfExport
        );

        parseExportSection(numberOfExport);

        const nodes = [];

        return { nodes, metadata };
      }

      case sections.code: {
        dumpSep("section Code");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const metadata = t.sectionMetadata(
          "code",
          startOffset,
          sectionSizeInBytes
        );

        if (opts.ignoreCodeSection === true) {
          eatBytes(sectionSizeInBytes); // eat the entire section
        } else {
          const u32 = readU32();
          const numberOfFuncs = u32.value;
          eatBytes(u32.nextIndex);

          metadata.vectorOfSize = numberOfFuncs;

          parseCodeSection(numberOfFuncs);
        }

        const nodes = [];

        return { nodes, metadata };
      }

      case sections.start: {
        dumpSep("section Start");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const metadata = t.sectionMetadata(
          "start",
          startOffset,
          sectionSizeInBytes
        );

        const nodes = [parseStartSection()];

        return { nodes, metadata };
      }

      case sections.elem: {
        dumpSep("section Element");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const numberOfElementsu32 = readU32();
        const numberOfElements = numberOfElementsu32.value;
        eatBytes(numberOfElementsu32.nextIndex);

        const metadata = t.sectionMetadata(
          "element",
          startOffset,
          sectionSizeInBytes,
          numberOfElements
        );

        const nodes = parseElemSection(numberOfElements);

        return { nodes, metadata };
      }

      case sections.global: {
        dumpSep("section Global");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const numberOfGlobalsu32 = readU32();
        const numberOfGlobals = numberOfGlobalsu32.value;
        eatBytes(numberOfGlobalsu32.nextIndex);

        const metadata = t.sectionMetadata(
          "global",
          startOffset,
          sectionSizeInBytes,
          numberOfGlobals
        );

        const nodes = parseGlobalSection(numberOfGlobals);

        return { nodes, metadata };
      }

      case sections.memory: {
        dumpSep("section Memory");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const numberOfElementsu32 = readU32();
        const numberOfElements = numberOfElementsu32.value;
        eatBytes(numberOfElementsu32.nextIndex);

        const metadata = t.sectionMetadata(
          "memory",
          startOffset,
          sectionSizeInBytes,
          numberOfElements
        );

        const nodes = parseMemorySection(numberOfElements);

        return { nodes, metadata };
      }

      case sections.data: {
        dumpSep("section Data");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const metadata = t.sectionMetadata(
          "data",
          startOffset,
          sectionSizeInBytes
        );

        if (opts.ignoreDataSection === true) {
          eatBytes(sectionSizeInBytes); // eat the entire section
          return { nodes: [], metadata };
        } else {
          const numberOfElementsu32 = readU32();
          const numberOfElements = numberOfElementsu32.value;
          eatBytes(numberOfElementsu32.nextIndex);

          metadata.vectorOfSize = numberOfElements;

          const nodes = parseDataSection(numberOfElements);
          return { nodes, metadata };
        }
      }

      case sections.custom: {
        dumpSep("section Custom");
        dump([sectionId], "section code");
        dump([sectionSizeInBytes], "section size");

        const nodes = [];
        const metadata = t.sectionMetadata(
          "custom",
          startOffset,
          sectionSizeInBytes
        );

        // We don't need to parse it, just eat all the bytes
        eatBytes(sectionSizeInBytes);

        return { nodes, metadata };
      }
    }

    throw new CompileError("Unexpected section: " + JSON.stringify(sectionId));
  }

  parseModuleHeader();
  parseVersion();

  const moduleFields = [];
  const moduleMetadata = {
    sections: []
  };

  /**
   * All the generate declaration are going to be stored in our state
   */
  while (offset < buf.length) {
    const { nodes, metadata } = parseSection();

    moduleFields.push(...nodes);
    moduleMetadata.sections.push(metadata);
  }

  /**
   * Transform the state into AST nodes
   */
  let funcIndex = 0;
  state.functionsInModule.forEach((func: DecodedModuleFunc) => {
    const params = func.signature.params;
    const result = func.signature.result;

    let body = [];

    // External functions doesn't provide any code, can skip it here
    if (func.isExternal === true) {
      return;
    }

    const decodedElementInCodeSection = state.elementsInCodeSection[funcIndex];

    if (opts.ignoreCodeSection === false) {
      body = decodedElementInCodeSection.code;
    }

    funcIndex++;

    const funcNode = t.func(func.id, params, result, body);

    if (func.isExternal === true) {
      funcNode.isExternal = func.isExternal;
    }

    moduleFields.push(funcNode);
  });

  state.elementsInExportSection.forEach(
    (moduleExport: DecodedElementInExportSection) => {
      /**
       * If the export has no id, we won't be able to call it from the outside
       * so we can omit it
       */
      if (moduleExport.id != null) {
        moduleFields.push(
          t.withLoc(
            t.moduleExport(
              moduleExport.name,
              moduleExport.type,
              moduleExport.id
            ),
            moduleExport.endLoc,
            moduleExport.startLoc
          )
        );
      }
    }
  );

  dumpSep("end of program");

  const module = t.module(null, moduleFields, moduleMetadata);
  return t.program([module]);
}
