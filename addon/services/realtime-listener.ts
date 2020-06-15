import Service from '@ember/service';
import { getOwner } from '@ember/application';
import DS from 'ember-data';
import { get } from '@ember/object';
import { run } from '@ember/runloop';
import { firestore, database, /*database*/ } from 'firebase/app';

// TODO don't hardcode these, but having trouble otherwise
import { normalize as firestoreNormalize } from '../serializers/firestore';
import { normalize as databaseNormalize } from '../serializers/realtime-database';

const getThisService = (object: Object) => getOwner(object).lookup('service:realtime-listener') as RealtimeListenerService;
const isFastboot = (object: Object) => {
    const fastboot = getOwner(object).lookup('service:fastboot');
    return fastboot && fastboot.isFastBoot;
};

export const subscribe = (subscriber: any, model: DS.Model, subscriptionId: string) => !isFastboot(subscriber) && getThisService(subscriber).subscribe(subscriber, model, subscriptionId);
export const unsubscribe = (subscriber: any, subscriptionId: string) => !isFastboot(subscriber) && getThisService(subscriber).unsubscribe(subscriber, subscriptionId);

const setSubscription = (thisService: RealtimeListenerService, subscriptionId: string, unsubscribe: (() => void) | null) => {
    const subscriptions = get(thisService, `subscriptions`);
    const existingSubscription = subscriptions[subscriptionId];
    if (existingSubscription) {
        existingSubscription();
    }
    if (unsubscribe) {
        subscriptions[subscriptionId] = unsubscribe;
    } else {
        delete subscriptions[subscriptionId];
    }
};
function isFirestoreQuery(arg: any): arg is firestore.Query {
    return arg.onSnapshot !== undefined;
}

function isFirestoreDocumentRefernce(arg: any): arg is firestore.DocumentReference {
    return arg.onSnapshot !== undefined;
}

export default class RealtimeListenerService extends Service.extend({
    subscriptions: {} as any
}) {
    subscribe(_subscriber: any, model: any, subscriptionId: string) {
        const store = model.store;
        const modelName = (model.modelName || model.get('_internalModel.modelName'));
        const modelClass = store.modelFor(modelName);
        const query = model.get('meta.query');
        const ref = model.get('_internalModel._recordData._data._ref');
        if (query) {
            if (isFirestoreQuery(query)) {
                const unsubscribe = query.onSnapshot(snapshot => {
                    snapshot.docChanges().forEach(change => run(() => {
                        const normalizedData = firestoreNormalize(store, modelClass, change.doc);
                        switch (change.type) {
                            case 'added': {
                                const current = model.content.objectAt(change.newIndex);
                                if (current == null || current.id !== change.doc.id) {
                                    const doc = store.push(normalizedData) as any;
                                    model.content.insertAt(change.newIndex, doc._internalModel);
                                }
                                break;
                            }
                            case 'modified': {
                                const current = model.content.objectAt(change.oldIndex);
                                if (current == null || current.id == change.doc.id) {
                                    if (change.newIndex !== change.oldIndex) {
                                        model.content.removeAt(change.oldIndex);
                                        model.content.insertAt(change.newIndex, current);
                                    }
                                }
                                store.push(normalizedData);
                                break;
                            }
                            case 'removed': {
                                const current = model.content.objectAt(change.oldIndex);
                                if (current && current.id == change.doc.id) {
                                    model.content.removeAt(change.oldIndex);
                                }
                                break;
                            }
                        }
                    }));
                });
                setSubscription(this, subscriptionId, unsubscribe);
            } else {
                const onChildAdded = query.on('child_added', (snapshot: database.DataSnapshot, priorKey: string) => {
                    run(() => {
                        if (snapshot) {
                            const normalizedData = databaseNormalize(store, modelClass, snapshot);
                            const doc = store.push(normalizedData) as any;
                            const existing = model.content.find((record: any) => record.id === doc.id);
                            if (existing) { model.content.removeObject(existing); }
                            let insertIndex = 0;
                            if (priorKey) {
                                const record = model.content.find((record: any) => record.id === priorKey);
                                insertIndex = model.content.indexOf(record) + 1;
                            }
                            const current = model.content.objectAt(insertIndex);
                            if (current == null || current.id !== doc.id) {
                                model.content.insertAt(insertIndex, doc._internalModel);
                            }
                        }
                    });
                });
                const onChildRemoved = query.on('child_removed', (snapshot: database.DataSnapshot) => {
                    run(() => {
                        if (snapshot) {
                            const record = model.content.find((record: any) => record.id === snapshot.key);
                            if (record) { model.content.removeObject(record); }
                        }
                    });
                });
                const onChildChanged = query.on('child_changed', (snapshot: database.DataSnapshot) => {
                    run(() => {
                        if (snapshot) {
                            const normalizedData = databaseNormalize(store, modelClass, snapshot);
                            store.push(normalizedData);
                        }
                    });
                });
                const onChildMoved = query.on('child_moved', (snapshot: database.DataSnapshot, priorKey: string) => {
                    run(() => {
                        if (snapshot) {
                            const normalizedData = databaseNormalize(store, modelClass, snapshot);
                            const doc = store.push(normalizedData) as any;
                            const existing = model.content.find((record: any) => record.id === doc.id);
                            if (existing) { model.content.removeObject(existing); }
                            if (priorKey) {
                                const record = model.content.find((record: any) => record.id === priorKey);
                                const index = model.content.indexOf(record);
                                model.content.insertAt(index + 1, doc._internalModel);
                            } else {
                                model.content.insertAt(0, doc._internalModel);
                            }
                        }
                    });
                });
                const unsubscribe = () => {
                    query.off('child_added', onChildAdded);
                    query.off('child_removed', onChildRemoved);
                    query.off('child_changed', onChildChanged);
                    query.off('child_moved', onChildMoved);
                };
                setSubscription(this, subscriptionId, unsubscribe);
            }
        } else if (ref) {
            if (isFirestoreDocumentRefernce(ref)) {
                const unsubscribe = ref.onSnapshot(doc => {
                    run(() => {
                        if (doc.exists) {
                            const normalizedData = firestoreNormalize(store, modelClass, doc);
                            store.push(normalizedData);
                        } else {
                            const record = store.peekRecord(modelName, doc.id);
                            if (record) {
                                record.set('isUnloaded', true);
                                record.set('unloadReason', 'document_does_not_exist');
                                store.unloadRecord(record);
                            }
                        }
                    });
                }, (error) => {
                    const record = store.peekRecord(modelName, ref.id);
                    if (record) {
                        record.set('isUnloaded', true);
                        record.set('unloadReason', error);
                        store.unloadRecord(record);
                    }
                });
                setSubscription(this, subscriptionId, unsubscribe);
            } else {
                const listener = ref.on('value', (snapshot: database.DataSnapshot) => {
                    run(() => {
                        if (snapshot) {
                            if (snapshot.exists()) {
                                const normalizedData = databaseNormalize(store, modelClass, snapshot);
                                store.push(normalizedData);
                            } else {
                                const record = store.peekRecord(modelName, snapshot.key!);
                                if (record) {
                                    store.unloadRecord(record);
                                }
                            }
                        }
                    });
                });
                const unsubscribe = () => ref.off('value', listener);
                setSubscription(this, subscriptionId, unsubscribe);
            }
        }
    }
    unsubscribe(_subscriber: any, subscriptionId: string) {
        setSubscription(this, subscriptionId, null);
    }
}
declare module '@ember/service' {
    interface Registry {
        "realtime-listener": RealtimeListenerService;
    }
}