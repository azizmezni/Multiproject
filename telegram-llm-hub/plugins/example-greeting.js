// Example plugin: Custom greeting node
// Each plugin exports: name, description, nodeType, execute
export const name = 'greeting';
export const description = 'Generate a custom greeting message';
export const nodeType = {
  emoji: '👋',
  label: 'Greeting',
  desc: 'Generate personalized greetings',
};

// Execute function receives: { inputData, config, env, userId }
export async function execute({ inputData, config }) {
  const name = inputData?.name || config?.name || 'World';
  const style = config?.style || 'formal';
  const greetings = {
    formal: `Dear ${name}, I hope this message finds you well.`,
    casual: `Hey ${name}! What's up?`,
    fun: `Yo ${name}! 🎉 Let's gooo!`,
  };
  return { result: greetings[style] || greetings.formal, outputs: { greeting: greetings[style] } };
}
