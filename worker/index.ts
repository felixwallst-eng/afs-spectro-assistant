type ClefRunner = { run: (model: string, input: unknown) => Promise<unknown> };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/clef-test") {
      const ai = env.AI as unknown as ClefRunner;
      const result = await ai.run("@cf/cloudflare/clef", {
        model: "clef",
        state:
          "We produce an opaque, concentrated milk product that flows through a processing line. We currently sample it for fat and protein analysis and would like earlier information about composition changes. Product temperature and texture vary during production. We want an initial spectroscopy concept and a practical comparison experiment, while retaining our laboratory checks. The solution must be inexpensive, as we plan to install it on several lines.",
        questions: {
          budget: {
            type: "choice",
            instructions:
              "What cost or budget level does the client indicate for the measurement solution? Only use what the client explicitly states.",
            criteria: {
              low: "The client explicitly asks for a low-cost, inexpensive or budget solution.",
              avr: "The client indicates a moderate budget or explicitly accepts standard costs.",
              high: "The client explicitly accepts high cost or says budget is not a constraint.",
              na: "The client says nothing about cost or budget.",
            },
          },
          sample_state: {
            type: "choice",
            instructions:
              "What is the physical state and optical appearance of the sample at the measurement point, as stated by the client? Only use what the client explicitly states.",
            criteria: {
              powder_or_granular: "Powder, blend, granulate, pellets.",
              clear_liquid: "A liquid described as clear, transparent or relatively clear.",
              turbid_liquid_or_suspension: "A liquid described as turbid, optically dense or a suspension.",
              opaque_liquid_or_emulsion: "A liquid described as opaque, concentrated or emulsion-like.",
              liquid_optics_unspecified: "A liquid, but its clarity/turbidity is not stated.",
              melt_or_paste: "Polymer melt, paste, highly viscous mass.",
              soft_solid_or_tissue: "Biological tissue or other soft solid.",
              not_stated: "The sample state is not stated.",
            },
          },
        },
      });
      return Response.json(result);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ status: "ok" });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;