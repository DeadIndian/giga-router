// Observe native streams without imposing a translated protocol's content schema.
function streamState(format) {
  const choices = new Map();
  let started = false, stopped = false, reason;
  return {
    observe(data) {
      if (format === 'openai') for (const choice of data.choices || []) choices.set(choice.index ?? 0, choice.finish_reason || choices.get(choice.index ?? 0) || null);
      if (format === 'anthropic') {
        if (data.type === 'message_start') started = true;
        if (data.type === 'message_delta') reason = data.delta?.stop_reason || reason;
        if (data.type === 'message_stop') stopped = true;
      }
      if (format === 'responses' && ['response.completed', 'response.incomplete'].includes(data.type)) stopped = true;
    },
    finish() {
      if (format === 'openai' && (!choices.size || [...choices.values()].some(reason => !reason))) throw new Error('Upstream stream ended before finish_reason');
      if (format === 'anthropic' && (!started || !stopped || !reason)) throw new Error('Upstream stream ended before message_stop');
      if (format === 'responses' && !stopped) throw new Error('Upstream stream ended before a terminal response event');
    },
  };
}
module.exports = { streamState };
