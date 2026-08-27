import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "greet",
  async setup(ctx) {
    const registration = await ctx.tool.transform((draft) => {
      draft.add({
        name: "greeting",
        description: "Create a greeting",
        input: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        options: { namespace: "greet" },
        execute: async (input) => {
          const { name } = input as { name: string }
          return { content: `Hello, ${name}!` }
        },
      })
    })

    const toolHook = await ctx.tool.hook("execute.after", (event) => {
      if (event.tool === "read") console.log("greet plugin: read executed")
    })

    console.log(`greet plugin loaded in OpenCode ${ctx.app.version}`)

    return () => {
      void registration.dispose()
      void toolHook.dispose()
      console.log("greet plugin unloaded")
    }
  },
})
