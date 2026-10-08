import { readFileSync } from "node:fs";

export const workflowIds = [
  "guardfulaiQaProduction",
  "guardfulaiQaStop",
  "guardfulaiQaContinue",
];
export const dummyCredentialId = "guardfulaiQaDummy";
export function missingWorkflows(prepared, saved) {
  return prepared.filter(
    (workflow) => !saved.some((value) => value.id === workflow.id),
  );
}

export function workflows(repo, batch) {
  const example = JSON.parse(
    readFileSync(`${repo}/examples/check-content.json`, "utf8"),
  );
  return workflowIds.map((id, index) => {
    const workflow = structuredClone(example);
    workflow.id = id;
    workflow.name = [
      "Guardful AI QA — production",
      "Guardful AI QA — errors stop",
      "Guardful AI QA — errors continue",
    ][index];
    const input = workflow.nodes[1];
    input.name = "Synthetic inputs";
    input.parameters.jsCode = `const c = $('QA settings').first().json;
const cases = {review:['first@example.test','second@example.test'],allow:['Hello support'],block:['person@example.test'],redact:['person@example.test']};
if (!cases[c.scenario] || !/^[1-9][0-9]*$/.test(String(c.revision))) throw new Error('Use review, allow, block or redact and a positive revision');
return cases[c.scenario].map((content,i)=>({json:{content,event_id:'qa-'+c.batch+'-'+c.scenario+'-r'+c.revision+'-'+i,fixture_index:i,status:'completed',decision:'allow',safe_to_continue:true}}));`;
    const settings = {
      id: "qa-settings",
      name: "QA settings",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [200, 0],
      parameters: {
        assignments: {
          assignments: [
            {
              id: "scenario",
              name: "scenario",
              value: "review",
              type: "string",
            },
            { id: "revision", name: "revision", value: "1", type: "string" },
            { id: "batch", name: "batch", value: batch, type: "string" },
          ],
        },
        options: {},
      },
    };
    const check = workflow.nodes[2];
    check.onError = index === 2 ? "continueRegularOutput" : "stopWorkflow";
    if (index)
      check.credentials = {
        guardfulaiApi: {
          id: dummyCredentialId,
          name: "Guardful AI QA dummy (local only)",
        },
      };
    // Error responses omit decision; an empty string still fails strict equality to Allow.
    workflow.nodes[3].parameters.conditions.conditions[1].leftValue =
      "={{ $json.decision ?? '' }}";
    const pairing = {
      id: "qa-pairing",
      name: "Inspect pairing",
      type: "n8n-nodes-base.set",
      typeVersion: 3.4,
      position: [680, 0],
      parameters: {
        includeOtherFields: true,
        assignments: {
          assignments: [
            {
              id: "event",
              name: "qa_source_event_id",
              value: "={{ $('Synthetic inputs').item.json.event_id }}",
              type: "string",
            },
            {
              id: "index",
              name: "qa_input_index",
              value: "={{ $('Synthetic inputs').item.json.fixture_index }}",
              type: "number",
            },
          ],
        },
        options: {},
      },
    };
    workflow.nodes.push(settings, pairing);
    workflow.nodes.forEach((node, i) => {
      node.position = [i * 220, index * 40];
    });
    workflow.connections[workflow.nodes[0].name].main[0][0].node =
      settings.name;
    workflow.connections[settings.name] = {
      main: [[{ node: input.name, type: "main", index: 0 }]],
    };
    delete workflow.connections["Synthetic messages"];
    workflow.connections[input.name] = {
      main: [[{ node: check.name, type: "main", index: 0 }]],
    };
    workflow.connections[check.name].main[0][0].node = pairing.name;
    workflow.connections[pairing.name] = {
      main: [[{ node: "Continue only on Allow", type: "main", index: 0 }]],
    };
    workflow.nodes.at(-2).position = [220, 0];
    input.position = [440, 0];
    check.position = [660, 0];
    pairing.position = [880, 0];
    workflow.nodes[3].position = [1100, 0];
    workflow.nodes[4].position = [1320, 0];
    workflow.nodes[5].position = [1320, 220];
    workflow.nodes[4].name = "Allow — harmless end";
    workflow.nodes[5].name = "Review, Block or error — harmless end";
    workflow.connections["Continue only on Allow"].main[0][0].node =
      workflow.nodes[4].name;
    workflow.connections["Continue only on Allow"].main[1][0].node =
      workflow.nodes[5].name;
    return workflow;
  });
}
