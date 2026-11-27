/** Plain-language explanations of diagnostics and runtime errors, for beginners.
 *
 * The technical message and code stay available; these sentences are what the editor shows first. */
import { Diag } from "./checker.js";
import { capitalize, isIdentifier } from "./pyutil.js";

const TYPE_WORDS: Record<string, string> = {
  bool: "a true/false value",
  string: "text",
  f32: "a decimal number",
  f64: "a decimal number",
  exec: "an exec (order) wire",
};

export function typeWords(ty: string): string {
  if (ty.startsWith("array#<") && ty.endsWith(">")) {
    const inner = ty.slice("array#<".length, -1);
    let words = typeWords(inner).split(" (")[0];
    for (const article of ["a ", "an "]) if (words.startsWith(article)) words = words.slice(article.length);
    return !words.endsWith("text") ? `a list of ${words}s (${ty})` : `a list of texts (${ty})`;
  }
  if (ty in TYPE_WORDS) return `${TYPE_WORDS[ty]} (${ty})`;
  if (ty && "iu".includes(ty[0]) && /^\d+$/.test(ty.slice(1))) {
    const sign = ty[0] === "i" ? "" : "non-negative ";
    return `a ${sign}whole number (${ty})`;
  }
  return ty && isIdentifier(ty) ? `a ${ty} value` : ty;
}

export function zeroWords(ty: string): string {
  return ({ bool: "false", string: "empty text", f32: "0.0", f64: "0.0" } as Record<string, string>)[ty] ?? "0";
}

function quoted(msg: string, i = 0): string | null {
  const found = [...msg.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return found.length > i ? found[i] : null;
}

const cap1 = (m: string) => m[0].toUpperCase() + m.slice(1);

export function explain(d: Diag): string {
  const c = d.code, m = d.message, node = d.node, pin = d.pin;
  const data = d.data ?? {};
  const here = pin ? `'${pin}'` : "this";
  const q = (i = 0) => quoted(m, i);
  if (c === "E0101") {
    if (m.includes("no Entry")) return "Every function needs an Entry node, where it starts. Add one: right-click → Flow → Entry.";
    return `This wire points at a node called '${q()}', but there is no such node. It may have been renamed or deleted. Reconnect the wire.`;
  }
  if (c === "E0102") {
    if (m.includes("Entry")) return "A function can only start in one place, so it can only have one Entry node.";
    if (m.includes("built-in type"))
      return `'${q()}' is already the name of a built-in type, so a struct or enum can't use it. Pick a different name, such as ${capitalize(q() ?? "")}Info.`;
    if (m.includes("also the name of an enum"))
      return `This node is called '${q()}', the same as an enum, so '${q()}.something' could mean either. Rename the node.`;
    if (m.includes("duplicate field") || m.includes("duplicate member"))
      return `'${q()}' is listed twice in '${q(1)}'. Each field or member needs its own name.`;
    return `Two things are called '${q() || node}'. Every node needs its own name.`;
  }
  if (c === "E0103") return `${cap1(m)}. Check the pin name (the node registry lists every pin).`;
  if (c === "E0110") {
    if (m.includes("of enum member"))
      return `Enum member '${q()}' has the value ${m.split(/\s+/)[1]}, which is too big or too small for ${typeWords(data.dst)}. ` +
             `Give it a smaller value, or give the enum a wider type such as i32.`;
    if (m.includes("default of field"))
      return `The starting value of field '${q()}' isn't ${typeWords(data.dst)}. Change it, or remove it to start at ${zeroWords(data.dst)}.`;
    if (m.startsWith("case ")) {
      const dst = data.dst;
      const fix = m.includes("Member") ? ` Write each case as ${dst}::Member.` : "";
      return `Case ${m.split(/\s+/)[1]} of this Switch isn't ${typeWords(dst)}, so the value could never match it.${fix}`;
    }
    if (m.includes("default of '"))
      return `The starting value of '${q()}' is a value of a different enum. It needs to be ${typeWords(data.dst)}.`;
    if (data.literal) return `The value typed into ${here} isn't ${typeWords(data.dst)}.`;
    if ("src" in data) {
      const fix = data.src !== "exec" ? "Drag the wire again and Wiret will add a Convert node for you." : "";
      return `Input ${here} needs ${typeWords(data.dst)}, but the wire brings ${typeWords(data.src)}. ${fix}`.trim();
    }
    return cap1(m) + ".";
  }
  if (c === "E0111") return `Input ${here} is connected twice. An input can only receive one value.`;
  if (c === "E0120")
    return "White exec wires decide the ORDER things happen in; coloured data wires carry VALUES. " +
           "An exec pin can only connect to an exec pin, and a data pin to a data pin.";
  if (c === "E0121")
    return `Exec output ${here} goes to two places. An exec output can only lead to one next step. To do several things in order, use a Sequence node.`;
  if (c === "E0201")
    return "This node waits (Delay, Yield, Await, or a call to something that waits), so the function it is in can pause partway. " +
           "Mark the function with @latent to say so; then whatever calls it must be @latent too, or be an event.";
  if (c === "E0301")
    return "These calculations depend on each other in a circle, so none of them can be worked out first. " +
           "Break the circle, for example by storing a value in a local variable.";
  if (c === "E0302")
    return "This function promises (with @pure or @reads) that it only calculates a result, but this node changes something. " +
           "Remove the promise from the function's signature, or remove the node.";
  if (c === "E0304")
    return "This function is marked @pure, which promises its result depends only on its inputs. This node reads or calls " +
           "something that could change, which breaks the promise. Pass the value in as an input instead, or remove @pure.";
  if (c === "E0401") return "This macro uses itself, so expanding it would never end.";
  if (c === "E0150")
    return "A method with the same name as one in the parent class replaces it (an override), so it must take the same inputs " +
           "and give the same outputs. A method marked @final cannot be replaced at all. Rename this method, or match the parent's signature.";
  if (c === "E0501" && m.includes("CallParent"))
    return "CallParent runs the parent class's version of the method it is in. It only works inside a method that overrides one " +
           "from a parent class (the class line says ': Parent', and the parent has a method of the same name).";
  if (c === "E0160")
    return "This project's wiret.toml lists which capabilities its modules may ask for, and this one is not on the list. " +
           "Add it to 'allow' under [capabilities] if the project should be able to use it.";
  if (c === "E0152")
    return "A class that says it implements an interface (with 'impl') must have a method for every method the interface lists, " +
           "with the same inputs and outputs. Add the missing method, or fix its inputs and outputs to match.";
  if (c === "E0151")
    return "A class can only extend another class of this module, and a class cannot end up extending itself through its parents. " +
           "Check the name after ':' in the class line.";
  if (c === "E0412")
    return "Everything wired after a Try's 'body' is protected by that Try, so it must only be reachable through 'body'. " +
           "Here a wire from outside the body leads into it (or the body loops back to the Try, or leaves a macro through Exit). " +
           "Give the outside path its own nodes, or move the shared part after the Try's 'then'.";
  if (c === "E0501") {
    if (m.includes("later tier")) return `'${q()}' nodes aren't available in this prototype yet.`;
    if (m.includes("unknown local")) return `There is no local variable called '${q()}' in this graph. Add one from Graph → Add local….`;
    if (m.includes("unresolved function")) return `There is no function called '${q()}'. Check the spelling or create it.`;
    if (m.includes("unresolved macro")) return `There is no macro called '${q()}'. Built-in ones start with std.flow.`;
    if (m.includes("cannot be a map key") || m.includes("cannot be a set item"))
      return `'${q()}' can't be used to look things up. Map keys and set items must be simple values: numbers, text, ` +
             `true/false, enums, or structs made only of those.`;
    if (m.includes("names the struct")) {
      const kind = m.split(/\s+/)[0];
      const example = m.includes("and the field") ? `${kind} Vec2.x` : `${kind} Vec2`;
      return `${kind} needs to know which struct it works on. Write it like '${example}', using your own struct's name.`;
    }
    if (m.includes("takes no type arguments; the struct"))
      return "Struct nodes don't take a #<...> type. The struct's name already says what type the node works with.";
    if (m.includes("unknown struct")) {
      if (m.includes("is an enum")) return `'${q()}' is an enum, not a struct, so it has no fields to make, break or read.`;
      return `There is no struct called '${q()}'. Check the spelling, or declare it with 'struct ${q()} { ... }'.`;
    }
    if (m.includes("has no field")) return `Struct '${q()}' doesn't have a field called '${q(1)}'. Check the spelling against the struct's declaration.`;
    if (m.includes("structs are immutable"))
      return "A struct can't be changed in place. WithField makes a copy with one field changed; store the copy where the old one was.";
    if (m.includes("unknown enum")) return `There is no enum called '${q()}'. Check the spelling, or declare it with 'enum ${q()} { ... }'.`;
    if (m.includes("has no member")) {
      const names = (data.members ?? []).join(", ");
      const listing = names ? ` Its members are: ${names}.` : " It has no members yet.";
      return `Enum '${q()}' doesn't have a member called '${q(1)}'.${listing}`;
    }
    if (m.includes("module prefix"))
      return `Inside its own module, a type is written without the module name: write '${q(1)}' instead of '${q()}'.`;
    if (m.includes("unknown type"))
      return `There is no type called '${q()}'. Check the spelling, or declare it with 'struct ${q()} { ... }' or 'enum ${q()} { ... }'.`;
    if (m.includes("cannot compile struct and enum"))
      return `'${q()}' is declared correctly, but this prototype can't run programs that use struct or enum values yet.`;
    if (m.includes("cannot have type exec"))
      return "Exec wires decide the order things happen in; they aren't values, so a field can't hold one.";
    if (m.includes("unknown node kind")) return `Wiret doesn't know a node kind called '${q()}'.`;
    return cap1(m) + ".";
  }
  if (c === "E0503") {
    const i = m.indexOf(": ");
    return `Struct '${q()}' contains itself (${i >= 0 ? m.slice(i + 2) : ""}). Every value would need another one inside it, forever. ` +
           `Hold the inner one in an array instead, which can start empty.`;
  }
  if (c === "E0502") {
    const kind = m.split(/\s+/)[0];
    return `${kind} needs to know what kind of value it works with. Write it like ${kind}#<i32> for whole numbers or ${kind}#<f64> for decimals.`;
  }
  if (c === "W0201") {
    const ty = data.type ?? "";
    return `Input ${here} isn't connected and has no default, so it will be ${zeroWords(ty)}. Connect a wire, or double-click the pin to type a value.`;
  }
  if (c === "W0203")
    return `Enum '${q()}' is marked @export, but an enum is saved as plain numbers, so there is nothing to export and the mark does nothing. ` +
           `Remove @export; functions that are exported can still take and return its values.`;
  if (c === "W0301") return "Nothing leads to this node, so it will never run. Connect a white exec wire into it from the step that should come before it.";
  if (c === "W0302") return "The function can stop here without reaching a Return node, so it would return zero. Connect this path to a Return.";
  if (c === "E0310")
    return `This uses a result from '${q()}', but '${q()}' doesn't run on every path before this node, so there might be no value to use. ` +
           `Store the value in a local variable on every path instead.`;
  if (c === "E0320")
    return `'${q()}' reads something that can change (a field, a variable or state), and it is read again at each step that uses it. ` +
           `Two of those steps can run one after the other, so the second may see a different value than the first. To use one value, ` +
           `store it in a local before the first step (Set, then Get the local). If each step should see the value as it is then, mark the node @live.`;
  if (c === "E0130")
    return "Nodes that change an array, map or set need to know which one to change: the name of a local variable or module variable " +
           "that holds it, written after the type, as in ArrayAdd#<i32> scores or MapSet#<string, i32> ages.";
  if (c === "W0603")
    return "A '//' comment is kept when it stands directly above a declaration, a statement or an input, with no blank line between. " +
           "This one doesn't (it has a blank line under it, or ends a line of code), so formatting would drop it. " +
           "Move it, or use File → Convert // comments to notes to keep it as a note.";
  if (c === "W0604") return "This note was attached to something that has been deleted.";
  return m;
}

export function explainRuntime(status: string, message: string, where = ""): string {
  const loc = where ? ` in ${where}` : "";
  if (status === "WR_ERR_FAULT") {
    if (message.includes("divide by zero") || message.includes("remainder by zero"))
      return `The program tried to divide by zero${loc}. Dividing by zero has no answer, so the program stopped. ` +
             `Use a Branch to check the number first, or put the division in the body of a Try to handle the error.`;
    if (message.includes("continuation stack overflow"))
      return `A Sequence keeps starting itself again before it finishes${loc}, so unfinished steps pile up forever. ` +
             `This is a loop that never ends: make sure something lets it stop, for example a Branch.`;
    if (message.includes("stack overflow"))
      return `A function kept calling itself and never stopped${loc}. A function that calls itself needs a case where it stops (a 'base case').`;
    if (message.includes("array index"))
      return `The program asked for an item that isn't in the array${loc}: ${message}. Array positions start at 0, so the last item is at length − 1.`;
    if (message.includes("Substring")) return `The program asked for part of a text that doesn't exist${loc}: ${message}.`;
    return `The program stopped with an error${loc}: ${message}. A Try around the nodes that can fail lets the program handle the error and carry on.`;
  }
  if (status === "WR_ERR_FUEL")
    return "The program ran for too long and was stopped. This usually means a loop never ends: check that the loop's condition can become false.";
  if (status === "WR_YIELD")
    return `The program is waiting${loc} for a signal, and nothing is left running that could fire it, so it can never carry on. ${message}`;
  if (status === "WR_ERR_INTERRUPT") return "You stopped the program.";
  if (status === "WR_ERR_LINK" && message.includes("capability"))
    return `The program needs permission the runner has not given it: ${message}. A host decides what a module may do; ` +
           `from the command line, add --grant with the capability's name.`;
  if (status === "WR_ERR_LINK") return `The program uses something the runtime doesn't provide: ${message}.`;
  if (status === "WR_ERR_LOAD" || status === "WR_ERR_VERIFY") return `The compiled file is damaged or invalid: ${message}.`;
  return message;
}
