package v1alpha2

import (
	"slices"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var GroupVersion = schema.GroupVersion{Group: "restic.bartl.sh", Version: "v1alpha2"}

func AddToScheme(s *runtime.Scheme) error {
	s.AddKnownTypes(GroupVersion, &ResticApplication{}, &ResticApplicationList{})
	metav1.AddToGroupVersion(s, GroupVersion)
	return nil
}

type Remote struct {
	Host              string `json:"host"`
	Repository        string `json:"repository"`
	CredentialsSecret string `json:"credentialsSecret"`
}
type Repository struct {
	Name           string  `json:"name"`
	AuthSecret     string  `json:"authSecret"`
	PasswordSecret string  `json:"passwordSecret"`
	Recovery       *Remote `json:"recovery,omitempty"`
}
type Replication struct {
	Name                    string `json:"name"`
	Repository              string `json:"repository"`
	SourceCredentialsSecret string `json:"sourceCredentialsSecret"`
	Destination             Remote `json:"destination"`
	Schedule                string `json:"schedule"`
	TimeZone                string `json:"timeZone,omitempty"`
	Suspend                 bool   `json:"suspend,omitempty"`
	ActiveDeadlineSeconds   int64  `json:"activeDeadlineSeconds,omitempty"`
}
type Spec struct {
	Running       bool          `json:"running"`
	ExistingClaim string        `json:"existingClaim"`
	TLSSecret     string        `json:"tlsSecret"`
	Image         string        `json:"image"`
	Repositories  []Repository  `json:"repositories"`
	Replication   []Replication `json:"replication,omitempty"`
}
type Operation struct {
	ID         string `json:"id"`
	JobName    string `json:"jobName"`
	JobUID     string `json:"jobUID,omitempty"`
	PVCUID     string `json:"pvcUID"`
	Generation int64  `json:"generation"`
	InputHash  string `json:"inputHash"`
	Result     string `json:"result"`
	Reason     string `json:"reason,omitempty"`
}
type Status struct {
	State              string             `json:"state"`
	Reason             string             `json:"reason,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration"`
	Operation          *Operation         `json:"operation,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}
type ResticApplication struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              Spec   `json:"spec"`
	Status            Status `json:"status,omitempty"`
}
type ResticApplicationList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ResticApplication `json:"items"`
}

func (a *ResticApplication) DeepCopyObject() runtime.Object {
	if a == nil {
		return (*ResticApplication)(nil)
	}
	b := new(ResticApplication)
	*b = *a
	a.ObjectMeta.DeepCopyInto(&b.ObjectMeta)
	b.Spec.Repositories = slices.Clone(a.Spec.Repositories)
	for i := range b.Spec.Repositories {
		if a.Spec.Repositories[i].Recovery != nil {
			v := *a.Spec.Repositories[i].Recovery
			b.Spec.Repositories[i].Recovery = &v
		}
	}
	b.Spec.Replication = append([]Replication(nil), a.Spec.Replication...)
	b.Status.Conditions = append([]metav1.Condition(nil), a.Status.Conditions...)
	if a.Status.Operation != nil {
		v := *a.Status.Operation
		b.Status.Operation = &v
	}
	return b
}
func (a *ResticApplicationList) DeepCopyObject() runtime.Object {
	if a == nil {
		return (*ResticApplicationList)(nil)
	}
	b := new(ResticApplicationList)
	*b = *a
	a.ListMeta.DeepCopyInto(&b.ListMeta)
	b.Items = make([]ResticApplication, len(a.Items))
	for i := range a.Items {
		b.Items[i] = *a.Items[i].DeepCopyObject().(*ResticApplication)
	}
	return b
}
