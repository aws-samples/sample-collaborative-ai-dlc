# Content Validation Rules

## MANDATORY: Content Validation Before Code Generation

**CRITICAL**: All generated code MUST be validated before writing to the filesystem.

## Code Validation

### Pre-Generation Validation Checklist
- [ ] Validate code syntax and structure
- [ ] Check special character escaping
- [ ] Verify imports and dependencies are correct
- [ ] Test content parsing compatibility
- [ ] Ensure generated code compiles/parses correctly

### Code Quality Rules
1. **Always validate before writing files**: Never write unvalidated code to the filesystem
2. **Escape special characters**: Particularly in strings, templates, and configuration files
3. **Verify syntax**: Validate language-specific syntax before writing
4. **Test imports**: Ensure all imports reference existing modules

## ASCII Diagram Standards (for code comments only)

**When generating code that includes ASCII diagrams in comments:**

1. **VALIDATE** each diagram:
   - Count characters per line (all lines MUST be same width)
   - Use ONLY: `+` `-` `|` `^` `v` `<` `>` and spaces
   - NO Unicode box-drawing characters
   - Spaces only (NO tabs)
2. **TEST** alignment by verifying box corners align vertically

**See `common/ascii-diagram-standards.md` for patterns and validation checklist.**

## Validation Failure Handling

### When Validation Fails
1. **Log the error**: Record what failed validation
2. **Fix the issue**: Correct the validation error
3. **Retry**: Re-validate after fixing
4. **Continue workflow**: Don't block on non-critical validation failures
5. **Inform team**: Use `ask_question` if validation failure affects the design or requires input
