<script setup lang="ts">
const props = defineProps<{ footer?: boolean }>();
let Footer: unknown;
if (props.footer) {
  await (globalThis as { emailRenderGate?: Promise<void> }).emailRenderGate;
  Footer = (await import("./Footer.vue")).default;
}
</script>
<template><p>Welcome</p><component :is="Footer" v-if="Footer" /></template>
