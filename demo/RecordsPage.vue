<script setup lang="ts">
import { computed, ref } from "vue";

interface RecordRow {
  id: number;
  name: string;
  status: string;
}

const records = ref<RecordRow[]>([
  { id: 1, name: "Customer sync", status: "Active" },
  { id: 2, name: "Invoice delivery", status: "Paused" },
]);
const name = ref("");
const _visibleRecords = computed(() => records.value);

function _addRecord(): void {
  const value = name.value.trim();
  if (!value) return;
  records.value.push({
    id: records.value.length + 1,
    name: value,
    status: "Active",
  });
  name.value = "";
}
</script>

<template>
  <main class="mx-auto max-w-5xl p-8">
    <h1 class="text-3xl font-semibold">Workflow records</h1>
    <form class="my-6 flex gap-3" @submit.prevent="_addRecord">
      <label for="record-name">Workflow name</label>
      <input id="record-name" v-model="name" class="border p-2" />
      <button type="submit">Add workflow</button>
    </form>
    <table class="w-full text-left">
      <caption>Configured workflows</caption>
      <thead><tr><th>Name</th><th>Status</th></tr></thead>
      <tbody>
        <tr v-for="record in _visibleRecords" :key="record.id">
          <td>{{ record.name }}</td><td>{{ record.status }}</td>
        </tr>
      </tbody>
    </table>
    <a href="/missing">Open error page</a>
  </main>
</template>
