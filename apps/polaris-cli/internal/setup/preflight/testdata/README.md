# preflight testdata

Empty testdata/ exists so tools_test.go can point PATH at a directory
that contains no executables, forcing the missing-binary branch of
CheckPnpm / CheckPolarisEmail / CheckTool. Don't add real binaries
here.
